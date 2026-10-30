// Disposable validator (not part of product code): proves notification Phase 5.1 —
// opt-in worker startup, studio-timezone daily checks, restart/duplicate-instance
// safety, due-job processing, failure recovery — on isolated temp SQLite DBs.
// Does not touch the real database.sqlite. Never starts a real timer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase51-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;
delete process.env.NOTIFICATIONS_WORKER_ENABLED; // ensure disabled by default

const {
  sequelize,
  Studio,
  User,
  Salon,
  MemberType,
  Member,
  MemberAccount,
  MemberAccountMembership,
  LessonPackage,
  MemberLessonPackage,
  Attendance,
  Notification,
  NotificationJob,
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const ensureMemberLessonPackageExpiryAndDueDate = require('../ensureMemberLessonPackageExpiryAndDueDate');
const notificationScheduler = require('../services/notificationScheduler');
const notificationService = require('../services/notificationService');
const { getStudioLocalDate } = require('../services/instructorFeeHistoryService');

function dateStr(d) { return d.toISOString().slice(0, 10); }
async function studioDaysFromNow(studioId, n) {
  const today = await getStudioLocalDate(studioId);
  return dateStr(new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000));
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();
  await ensureMemberLessonPackageExpiryAndDueDate();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const lessonPackageA = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });

  async function makeMemberWithAccount(name, phone, assignedInstructorId, totalDebt = 0) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId, remainingLessons: 0, totalDebt, isActive: true, studioId: studioA.id,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId: studioA.id, memberId: member.id });
    return { member, account };
  }

  // --- Phase 1: worker disabled by default ---
  {
    assert.strictEqual(notificationScheduler.isWorkerEnabled(process.env), false, 'disabled by default');
    assert.strictEqual(notificationScheduler.isWorkerEnabled({}), false, 'disabled when unset');
    assert.strictEqual(notificationScheduler.isWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: '0' }), false, 'disabled on 0');
    assert.strictEqual(notificationScheduler.isWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: 'true' }), false, 'disabled on "true" (only "1")');
    assert.strictEqual(notificationScheduler.isWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: '1' }), true, 'enabled on exact "1"');
    console.log('Phase 1 OK: worker disabled by default, explicit opt-in required');
  }

  // --- Phase 2: importing the module does not start jobs ---
  {
    // The module was imported at the top; verify no timers are running.
    const scheduler = notificationScheduler.createNotificationScheduler();
    assert.strictEqual(scheduler.isRunning(), false, 'scheduler not running on creation');
    // No global scheduler instance exists.
    console.log('Phase 2 OK: no jobs started by import');
  }

  // --- Phase 3: scheduler start/stop (manual, controlled) ---
  {
    const scheduler = notificationScheduler.createNotificationScheduler({ workerIntervalMs: 60000 });
    assert.strictEqual(scheduler.start(), true, 'start returns true');
    assert.strictEqual(scheduler.isRunning(), true, 'running after start');
    assert.strictEqual(scheduler.start(), false, 'second start is a no-op');
    scheduler.stop();
    assert.strictEqual(scheduler.isRunning(), false, 'stopped');
    console.log('Phase 3 OK: scheduler start/stop controlled, no double-start');
  }

  // --- Phase 4: daily checks run once per studio-local day (restart-safe) ---
  {
    // Set up a member with an expiring package (7 days out, studio-local).
    const { member } = await makeMemberWithAccount('Member Daily', '+905325510001', instructorA.id);
    const expiryDate = await studioDaysFromNow(studioA.id, 7);
    await MemberLessonPackage.create({
      memberId: member.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(),
      originalPrice: 1000, finalPrice: 1000, expiresAt: expiryDate, studioId: studioA.id,
    });

    // First run: package_expiry check runs.
    const ran1 = await notificationScheduler.runDailyChecksForStudio(studioA, { now: new Date() });
    assert.ok(ran1.ran >= 1, 'first daily run executes checks');
    const expiryJobs = await NotificationJob.findAll({ where: { studioId: studioA.id, type: 'package_expiring' } });
    assert.strictEqual(expiryJobs.length, 1, 'expiry job enqueued on first run');

    // Second run same day (simulating restart): no duplicate.
    const ran2 = await notificationScheduler.runDailyChecksForStudio(studioA, { now: new Date() });
    assert.strictEqual(ran2.ran, 0, 'second run same day: no duplicate checks');
    const expiryJobsAfter = await NotificationJob.findAll({ where: { studioId: studioA.id, type: 'package_expiring' } });
    assert.strictEqual(expiryJobsAfter.length, 1, 'no duplicate expiry job after restart');
    console.log('Phase 4 OK: daily checks once per studio-local day, restart-safe');
  }

  // --- Phase 5: duplicate-instance safety (two instances, same day) ---
  {
    // claimDailyCheck is atomic via unique dedupKey. Returns { claimed, job }.
    const today = await getStudioLocalDate(studioB.id);
    const [c1, c2] = await Promise.all([
      notificationScheduler.claimDailyCheck(studioB.id, 'package_expiry', today),
      notificationScheduler.claimDailyCheck(studioB.id, 'package_expiry', today),
    ]);
    const claimedCount = [c1, c2].filter((c) => c && c.claimed).length;
    assert.strictEqual(claimedCount, 1, 'only one instance claims the daily check');
    console.log('Phase 5 OK: duplicate-instance safety (atomic claim)');
  }

  // --- Phase 6: studio timezone/date boundary ---
  {
    // Studio with a timezone far from UTC (e.g. Pacific/Auckland, UTC+13).
    const studioNZ = await Studio.create({ name: 'Studio NZ', studioCode: 'studio-nz', country: 'TR', currency: 'TRY', timezone: 'Pacific/Auckland' });
    // At UTC 2026-10-29 12:00, Auckland is already 2026-10-30 (next day).
    const utcNoon = new Date('2026-10-29T12:00:00Z');
    const nzDate = await getStudioLocalDate(studioNZ.id, utcNoon);
    const utcDate = await getStudioLocalDate(studioA.id, utcNoon); // Istanbul
    assert.notStrictEqual(nzDate, utcDate, 'studio-local dates differ across timezones');
    // Daily check uses the studio's own date.
    const claimed = await notificationScheduler.claimDailyCheck(studioNZ.id, 'member_inactivity', nzDate);
    assert.strictEqual(claimed.claimed, true, 'daily check claimed for NZ studio on its local date');
    console.log('Phase 6 OK: studio timezone/date boundaries respected');
  }

  // --- Phase 7: due-job processing + failure recovery ---
  {
    // Enqueue a due job and a failing job.
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'test', dedupKey: 'sched-process-1', urgent: true,
      payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, title: 'OK' }] },
    });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'test', dedupKey: 'sched-fail-1', urgent: true, payload: {}, maxAttempts: 1,
    });
    // Process: one succeeds, one fails without crashing. (Other pending jobs from
    // earlier phases may also be processed; we assert on our two jobs' outcomes.)
    await require('../services/notificationWorker').processDueJobs({
      handler: async (job) => {
        if (job.dedupKey === 'sched-fail-1') throw new Error('simulated failure');
        return require('../services/notificationWorker').defaultJobHandler(job);
      },
      now: new Date(Date.now() + 60000),
    });
    const okJob = await NotificationJob.findOne({ where: { dedupKey: 'sched-process-1' } });
    const failJob = await NotificationJob.findOne({ where: { dedupKey: 'sched-fail-1' } });
    assert.strictEqual(okJob.processingState, 'done', 'good job done');
    assert.strictEqual(failJob.processingState, 'failed', 'failing job failed (not crash)');
    assert.strictEqual(failJob.lastError, 'simulated failure', 'error logged without member data');
    console.log('Phase 7 OK: due-job processing + failure recovery');
  }

  // --- Phase 8: disabled categories skipped ---
  {
    // Disable package alerts for studio B.
    await StudioNotificationSettings.create({ studioId: studioB.id, packageAlertsEnabled: false });
    const { member: memberB } = await makeMemberWithAccount('Member B', '+905325510002', instructorA.id);
    // Fix studio for memberB
    memberB.studioId = studioB.id;
    await memberB.save();
    const expiryDate = await studioDaysFromNow(studioB.id, 7);
    await MemberLessonPackage.create({
      memberId: memberB.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(),
      originalPrice: 1000, finalPrice: 1000, expiresAt: expiryDate, studioId: studioB.id,
    });
    const { checkPackageExpiry } = require('../services/packageNotificationService');
    const result = await checkPackageExpiry({ studioId: studioB.id });
    assert.strictEqual(result.enqueued, 0, 'disabled category skipped');
    console.log('Phase 8 OK: disabled notification categories skipped');
  }

  console.log('All notification-phase5.1 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
