const { Op } = require('sequelize');
const { sequelize, Studio, NotificationJob } = require('../models');
const { processDueJobs } = require('./notificationWorker');
const { processDuePushDeliveries } = require('./pushDeliveryService');
const {
  checkPackageExpiry,
  checkPaymentReminders,
  checkMemberInactivity,
} = require('./packageNotificationService');
const { getStudioLocalDate } = require('./instructorFeeHistoryService');

const DEFAULT_WORKER_INTERVAL_MS = 60 * 1000; // 1 minute
const DAILY_CHECK_TYPE = 'daily_check_marker';
const DAILY_CHECK_MAX_ATTEMPTS = 3;
const DAILY_CHECK_STALE_MS = 10 * 60 * 1000; // reclaim 'processing' claims after 10 min (crash recovery)

// Atomically claims a daily check for a studio+check+local-date.
// Lifecycle: claim as 'processing' -> run -> 'done' on success, back to 'pending'
// (with backoff) on failure. A 'done' marker means the check succeeded today and
// is never re-run. A stale 'processing' claim (process crash) is reclaimed.
// Returns { claimed, job } — claimed=true only when this caller should run it.
async function claimDailyCheck(studioId, checkName, studioLocalDate, { now = new Date() } = {}) {
  const dedupKey = `daily_check:${checkName}:${studioId}:${studioLocalDate}`;

  // Recover an abandoned 'processing' claim (crash) back to 'pending'.
  // Normalize the ISO 'T' separator so the datetime comparison works regardless
  // of how updatedAt was stored (Sequelize ISO vs raw SQL).
  const staleBefore = new Date(now.getTime() - DAILY_CHECK_STALE_MS).toISOString().replace('T', ' ').replace('Z', '');
  await NotificationJob.update(
    { processingState: 'pending' },
    {
      where: {
        dedupKey,
        studioId,
        type: DAILY_CHECK_TYPE,
        processingState: 'processing',
        [Op.and]: [
          sequelize.where(
            sequelize.fn('REPLACE', sequelize.col('updatedAt'), 'T', ' '),
            { [Op.lte]: staleBefore }
          ),
        ],
      },
    }
  );

  // Try to claim an existing pending claim (retry after failure).
  const [claimedExisting] = await NotificationJob.update(
    { processingState: 'processing' },
    {
      where: {
        dedupKey,
        studioId,
        type: DAILY_CHECK_TYPE,
        processingState: 'pending',
        [Op.or]: [
          { nextAttemptAt: null },
          { nextAttemptAt: { [Op.lte]: now } },
        ],
      },
    }
  );
  if (claimedExisting === 1) {
    const job = await NotificationJob.findOne({ where: { studioId, dedupKey } });
    return { claimed: true, job };
  }

  // Try to create a new claim. 'done' or 'processing' (fresh) -> not claimed.
  try {
    const job = await NotificationJob.create({
      studioId,
      type: DAILY_CHECK_TYPE,
      dedupKey,
      payload: null,
      scheduledAt: now,
      processingState: 'processing',
      attemptCount: 0,
      maxAttempts: DAILY_CHECK_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
    return { claimed: true, job };
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') return { claimed: false, job: null };
    throw error;
  }
}

// Marks a claimed daily check as successfully completed.
async function completeDailyCheck(job) {
  await job.update({ processingState: 'done', processedAt: new Date(), lastError: null });
}

// Marks a claimed daily check as failed: back to 'pending' with backoff, or
// 'failed' after max attempts. Never leaves it 'done' on failure.
async function failDailyCheck(job, error) {
  const attempts = Number(job.attemptCount) + 1;
  const exhausted = attempts >= Number(job.maxAttempts);
  const backoffMs = Math.min(60 * 1000 * Math.pow(2, attempts - 1), 30 * 60 * 1000);
  await job.update({
    processingState: exhausted ? 'failed' : 'pending',
    attemptCount: attempts,
    nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs),
    lastError: String((error && error.message) || error || 'Unknown error'),
  });
}

// Runs the three scheduled checks for one studio, once per studio-local day.
// Each check is independently claimed, failure-isolated, and retryable.
async function runDailyChecksForStudio(studio, { now = new Date() } = {}) {
  const studioId = studio.id;
  const studioLocalDate = await getStudioLocalDate(studioId, now);
  if (!studioLocalDate) return { ran: 0 };

  const checks = [
    ['package_expiry', checkPackageExpiry],
    ['payment_reminders', checkPaymentReminders],
    ['member_inactivity', checkMemberInactivity],
  ];

  let ran = 0;
  for (const [name, fn] of checks) {
    const { claimed, job } = await claimDailyCheck(studioId, name, studioLocalDate, { now });
    if (!claimed) continue; // already done today, or claimed by another instance
    try {
      await fn({ studioId, now });
      await completeDailyCheck(job);
      ran += 1;
    } catch (error) {
      // Log without member data; the claim goes back to 'pending' for retry.
      console.error(`[NotificationScheduler] daily check ${name} failed for studio ${studioId}:`, error && error.message);
      await failDailyCheck(job, error);
    }
  }
  return { ran };
}

// Runs daily checks for all studios (each in its own timezone/date).
async function runDailyChecks({ now = new Date() } = {}) {
  const studios = await Studio.findAll({ attributes: ['id', 'timezone'] });
  let totalRan = 0;
  for (const studio of studios) {
    try {
      const { ran } = await runDailyChecksForStudio(studio, { now });
      totalRan += ran;
    } catch (error) {
      console.error(`[NotificationScheduler] daily checks failed for studio ${studio.id}:`, error && error.message);
    }
  }
  return totalRan;
}

// Creates the scheduler. NOTHING starts until start() is called explicitly.
// The worker is disabled by default; the caller (app.js) gates on the env flag.
// pushTransport: injectable push transport. Push processing runs only when a
// transport is provided (the caller gates on PUSH_WORKER_ENABLED + credentials).
function createNotificationScheduler({
  workerIntervalMs = DEFAULT_WORKER_INTERVAL_MS,
  onError,
  pushTransport = null,
} = {}) {
  let workerTimer = null;
  let dailyTimer = null;
  let running = false;
  let ticking = false; // inbox overlap guard
  let pushTicking = false; // push overlap guard

  function logError(context, error) {
    const message = (error && error.message) || String(error);
    if (onError) {
      onError(context, message);
    } else {
      console.error(`[NotificationScheduler] ${context}:`, message);
    }
  }

  async function workerTick() {
    if (ticking) return; // prevent overlapping inbox ticks
    ticking = true;
    try {
      await processDueJobs();
    } catch (error) {
      logError('processDueJobs', error);
    } finally {
      ticking = false;
    }
  }

  async function pushTick() {
    if (!pushTransport) return; // push disabled
    if (pushTicking) return; // prevent overlapping push ticks
    pushTicking = true;
    try {
      await processDuePushDeliveries({ transport: pushTransport });
    } catch (error) {
      // Isolate push errors from inbox processing; never log tokens.
      logError('processDuePushDeliveries', error);
    } finally {
      pushTicking = false;
    }
  }

  async function dailyTick() {
    try {
      await runDailyChecks();
    } catch (error) {
      logError('runDailyChecks', error);
    }
  }

  function start() {
    if (running) return false;
    running = true;
    // Process due inbox jobs at the configured interval.
    workerTimer = setInterval(workerTick, workerIntervalMs);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
    // Process due push deliveries on the same interval (only when a transport
    // is configured). Errors are isolated from inbox processing.
    if (pushTransport) {
      const pushTimer = setInterval(pushTick, workerIntervalMs);
      if (typeof pushTimer.unref === 'function') pushTimer.unref();
      workerTimer._pushTimer = pushTimer; // track for stop()
    }
    // Daily checks run on the hourly interval only (each check self-dedups per
    // studio-local day). No immediate run on start, so a restart does not
    // double-fire and tests can control timing explicitly.
    dailyTimer = setInterval(dailyTick, 60 * 60 * 1000);
    if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
    return true;
  }

  function stop() {
    if (workerTimer) {
      clearInterval(workerTimer);
      if (workerTimer._pushTimer) clearInterval(workerTimer._pushTimer);
    }
    if (dailyTimer) clearInterval(dailyTimer);
    workerTimer = null;
    dailyTimer = null;
    running = false;
  }

  return { start, stop, isRunning: () => running };
}

// Reads the opt-in flag. Only the exact string '1' enables the worker.
function isWorkerEnabled(env = process.env) {
  return String(env.NOTIFICATIONS_WORKER_ENABLED || '').trim() === '1';
}

// Push processing requires BOTH the inbox worker AND an explicit push opt-in.
function isPushWorkerEnabled(env = process.env) {
  return isWorkerEnabled(env) && String(env.PUSH_WORKER_ENABLED || '').trim() === '1';
}

module.exports = {
  createNotificationScheduler,
  isWorkerEnabled,
  isPushWorkerEnabled,
  runDailyChecks,
  runDailyChecksForStudio,
  claimDailyCheck,
  completeDailyCheck,
  failDailyCheck,
  DAILY_CHECK_TYPE,
  DAILY_CHECK_MAX_ATTEMPTS,
  DAILY_CHECK_STALE_MS,
  DEFAULT_WORKER_INTERVAL_MS,
};
