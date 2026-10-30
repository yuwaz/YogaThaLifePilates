// Disposable validator (not part of product code): proves notification Phase 5.2 —
// daily check lifecycle (claim -> done on success, retry on failure, crash
// recovery, concurrent-instance safety, timezone boundaries, failure isolation)
// — on isolated temp SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase52-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;
delete process.env.NOTIFICATIONS_WORKER_ENABLED;

const {
  sequelize,
  Studio,
  NotificationJob,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const scheduler = require('../services/notificationScheduler');
const { getStudioLocalDate } = require('../services/instructorFeeHistoryService');

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioNZ = await Studio.create({ name: 'Studio NZ', studioCode: 'studio-nz', country: 'TR', currency: 'TRY', timezone: 'Pacific/Auckland' });

  // --- Phase 1: successful check runs once per local day ---
  {
    const today = await getStudioLocalDate(studioA.id);
    const { claimed, job } = await scheduler.claimDailyCheck(studioA.id, 'package_expiry', today);
    assert.strictEqual(claimed, true, 'first claim succeeds');
    assert.strictEqual(job.processingState, 'processing', 'claimed as processing (not done)');
    await scheduler.completeDailyCheck(job);
    await job.reload();
    assert.strictEqual(job.processingState, 'done', 'marked done after success');

    // Second claim same day -> not claimed (already done).
    const again = await scheduler.claimDailyCheck(studioA.id, 'package_expiry', today);
    assert.strictEqual(again.claimed, false, 'no re-claim after success');
    console.log('Phase 1 OK: successful check runs once per local day');
  }

  // --- Phase 2: failure -> retryable (not done) ---
  {
    const today = await getStudioLocalDate(studioA.id);
    const { claimed, job } = await scheduler.claimDailyCheck(studioA.id, 'payment_reminders', today);
    assert.strictEqual(claimed, true);
    await scheduler.failDailyCheck(job, new Error('simulated failure'));
    await job.reload();
    assert.strictEqual(job.processingState, 'pending', 'back to pending after failure');
    assert.strictEqual(Number(job.attemptCount), 1, 'attempt counted');
    assert.ok(job.nextAttemptAt, 'backoff scheduled');
    assert.strictEqual(job.lastError, 'simulated failure', 'error logged (no member data)');

    // Retry after backoff -> claimable again.
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    const retry = await scheduler.claimDailyCheck(studioA.id, 'payment_reminders', today);
    assert.strictEqual(retry.claimed, true, 'retry claimable after failure');
    await scheduler.completeDailyCheck(retry.job);
    console.log('Phase 2 OK: failure followed by successful retry');
  }

  // --- Phase 3: process crash / abandoned claim recovery ---
  {
    const today = await getStudioLocalDate(studioA.id);
    const { claimed, job } = await scheduler.claimDailyCheck(studioA.id, 'member_inactivity', today);
    assert.strictEqual(claimed, true);
    // Simulate crash: stuck in 'processing' with old updatedAt.
    await sequelize.query(
      "UPDATE NotificationJobs SET processingState='processing', updatedAt=? WHERE id=?",
      { replacements: [new Date(Date.now() - 20 * 60 * 1000).toISOString(), job.id] }
    );
    // New claim recovers the abandoned claim.
    const recovered = await scheduler.claimDailyCheck(studioA.id, 'member_inactivity', today);
    assert.strictEqual(recovered.claimed, true, 'abandoned claim recovered');
    await scheduler.completeDailyCheck(recovered.job);
    console.log('Phase 3 OK: crash / abandoned claim recovery');
  }

  // --- Phase 4: two concurrent scheduler instances ---
  {
    const today = await getStudioLocalDate(studioA.id);
    const [c1, c2] = await Promise.all([
      scheduler.claimDailyCheck(studioA.id, 'concurrent_check', today),
      scheduler.claimDailyCheck(studioA.id, 'concurrent_check', today),
    ]);
    const claimedCount = [c1, c2].filter((c) => c.claimed).length;
    assert.strictEqual(claimedCount, 1, 'only one instance claims the check');
    console.log('Phase 4 OK: concurrent scheduler instances');
  }

  // --- Phase 5: different studio timezones ---
  {
    // At UTC 2026-10-29 12:00, Auckland is 2026-10-30, Istanbul is 2026-10-29.
    const utcNoon = new Date('2026-10-29T12:00:00Z');
    const nzDate = await getStudioLocalDate(studioNZ.id, utcNoon);
    const trDate = await getStudioLocalDate(studioA.id, utcNoon);
    assert.notStrictEqual(nzDate, trDate, 'studio-local dates differ');
    // Each studio gets its own daily claim for its own date.
    const nzClaim = await scheduler.claimDailyCheck(studioNZ.id, 'tz_check', nzDate, { now: utcNoon });
    const trClaim = await scheduler.claimDailyCheck(studioA.id, 'tz_check', trDate, { now: utcNoon });
    assert.strictEqual(nzClaim.claimed, true, 'NZ studio claims its local date');
    assert.strictEqual(trClaim.claimed, true, 'TR studio claims its local date');
    console.log('Phase 5 OK: different studio timezones');
  }

  // --- Phase 6: one failing check does not block others ---
  {
    // Use runDailyChecksForStudio with a controlled failure. We inject a failing
    // check by temporarily replacing the module's check function is not possible
    // (closure), so we test claim/fail isolation directly per check.
    const today = await getStudioLocalDate(studioA.id);
    // Claim + fail package_expiry.
    const failClaim = await scheduler.claimDailyCheck(studioA.id, 'iso_fail', today);
    await scheduler.failDailyCheck(failClaim.job, new Error('iso failure'));
    // payment_reminders and member_inactivity for the same day should still be claimable.
    const other1 = await scheduler.claimDailyCheck(studioA.id, 'iso_ok1', today);
    const other2 = await scheduler.claimDailyCheck(studioA.id, 'iso_ok2', today);
    assert.strictEqual(other1.claimed, true, 'other check 1 not blocked');
    assert.strictEqual(other2.claimed, true, 'other check 2 not blocked');
    console.log('Phase 6 OK: one failing check does not block others');
  }

  // --- Phase 7: bounded retries (no infinite immediate retry) ---
  {
    const today = await getStudioLocalDate(studioA.id);
    const { claimed, job: initialJob } = await scheduler.claimDailyCheck(studioA.id, 'bounded_check', today);
    assert.strictEqual(claimed, true);
    let job = initialJob;
    // Fail maxAttempts times.
    for (let i = 0; i < 3; i++) {
      await scheduler.failDailyCheck(job, new Error('fail'));
      await job.reload();
      if (job.processingState === 'pending') {
        await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
        const retry = await scheduler.claimDailyCheck(studioA.id, 'bounded_check', today);
        if (retry.claimed) {
          job = retry.job;
        }
      }
    }
    await job.reload();
    assert.strictEqual(job.processingState, 'failed', 'exhausted after max attempts');
    assert.strictEqual(Number(job.attemptCount), 3, 'bounded at maxAttempts');
    // Not claimable after exhaustion.
    const afterExhaust = await scheduler.claimDailyCheck(studioA.id, 'bounded_check', today);
    assert.strictEqual(afterExhaust.claimed, false, 'not claimable after exhaustion');
    console.log('Phase 7 OK: bounded retries, no infinite immediate retry');
  }

  // --- Phase 8: worker disabled by default (unchanged) ---
  {
    assert.strictEqual(scheduler.isWorkerEnabled(process.env), false, 'disabled by default');
    assert.strictEqual(scheduler.isWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: '1' }), true, 'opt-in on "1"');
    console.log('Phase 8 OK: worker disabled by default');
  }

  console.log('All notification-phase5.2 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
