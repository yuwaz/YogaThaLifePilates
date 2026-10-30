// Disposable validator (not part of product code): proves the notification
// foundation — fresh/existing migrations, dedup, studio-scoped recipient
// resolution, quiet-hours timezone handling, retry/recovery/concurrency —
// against isolated temp SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-foundation-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  Salon,
  MemberType,
  Member,
  MemberAccount,
  MemberAccountMembership,
  Notification,
  NotificationJob,
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const notificationService = require('../services/notificationService');
const notificationWorker = require('../services/notificationWorker');

async function run() {
  // --- Phase 0: fresh + existing DB migration ---
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');

  await ensureNotificationTables();
  await ensureNotificationTables(); // idempotent
  for (const table of ['Notifications', 'NotificationJobs', 'StudioNotificationSettings']) {
    const [rows] = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?", { replacements: [table] });
    assert.strictEqual(rows.length, 1, `${table} created`);
  }
  console.log('Phase 0 OK: fresh + idempotent migration');

  // --- Fixtures ---
  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const adminA2 = await User.create({ username: 'adminA2', password: 'h', role: 'admin', studioId: studioA.id });
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const instructorB = await User.create({ username: 'instB', password: 'h', role: 'instructor', studioId: studioB.id });
  const salonA = await Salon.create({ name: 'S1', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'G', color: '#AABBCC', studioId: studioA.id });

  async function makeMember(name, phone, assignedInstructorId, studioId, memberTypeId, salonId) {
    return Member.create({
      name, phone, normalizedPhone: phone, memberTypeId, assignedSalonIds: [salonId],
      assignedInstructorId, remainingLessons: 10, isActive: true, studioId,
    });
  }

  // --- Phase 1: dedup uniqueness ---
  {
    const first = await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'test', dedupKey: 'dedup-1', payload: { x: 1 },
    });
    assert.strictEqual(first.created, true);
    const dup = await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'test', dedupKey: 'dedup-1', payload: { x: 2 },
    });
    assert.strictEqual(dup.created, false, 'duplicate dedupKey not recreated');
    assert.strictEqual(Number(dup.job.id), Number(first.job.id), 'same job returned');
    // Same dedupKey in another studio is allowed (studio-scoped uniqueness).
    const otherStudio = await notificationService.enqueueNotification({
      studioId: studioB.id, type: 'test', dedupKey: 'dedup-1', payload: { x: 3 },
    });
    assert.strictEqual(otherStudio.created, true, 'same dedupKey allowed in another studio');
    console.log('Phase 1 OK: dedup unique per studio');
  }

  // --- Phase 2: recipient resolution (studio isolation + instructor scoping) ---
  {
    const memberA = await makeMember('Member A', '+905321111111', instructorA.id, studioA.id, memberTypeA.id, salonA.id);
    const memberNoInst = await makeMember('Member NoInst', '+905322222222', null, studioA.id, memberTypeA.id, salonA.id);

    // Admins: same studio only.
    const adminsA = await notificationService.resolveAdminRecipients(studioA.id);
    assert.deepStrictEqual(adminsA.sort(), [adminA.id, adminA2.id].sort(), 'studio A admins only');
    const adminsB = await notificationService.resolveAdminRecipients(studioB.id);
    assert.deepStrictEqual(adminsB, [adminB.id], 'studio B admins only');

    // Instructor: only assigned member's instructor, same studio.
    const instForA = await notificationService.resolveInstructorRecipientForMember(studioA.id, memberA.id);
    assert.strictEqual(instForA, instructorA.id, 'assigned instructor resolved');
    const instNone = await notificationService.resolveInstructorRecipientForMember(studioA.id, memberNoInst.id);
    assert.strictEqual(instNone, null, 'no assigned instructor -> null');
    // Cross-studio: memberA's assignedInstructorId set to studio B instructor -> not resolved.
    memberA.assignedInstructorId = instructorB.id;
    await memberA.save();
    const instCross = await notificationService.resolveInstructorRecipientForMember(studioA.id, memberA.id);
    assert.strictEqual(instCross, null, 'cross-studio instructor not resolved');
    memberA.assignedInstructorId = instructorA.id;
    await memberA.save();

    // Member: linked account in same studio.
    const accountA = await MemberAccount.create({ normalizedPhone: '+905321111111', passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: accountA.id, studioId: studioA.id, memberId: memberA.id });
    const memberRecip = await notificationService.resolveMemberRecipient(studioA.id, memberA.id);
    assert.strictEqual(memberRecip, accountA.id, 'linked account resolved');
    const noAccount = await notificationService.resolveMemberRecipient(studioA.id, memberNoInst.id);
    assert.strictEqual(noAccount, null, 'no linked account -> null');
    console.log('Phase 2 OK: studio-scoped recipient resolution');
  }

  // --- Phase 3: quiet-hours handling (21:00-09:00 studio-local) ---
  {
    // Studio A timezone Europe/Istanbul (UTC+3).
    // 23:00 local = 20:00 UTC -> inside quiet hours -> deferred to 09:00 next day local.
    const nightUtc = new Date('2026-11-10T20:00:00Z'); // 23:00 Istanbul
    const deferred = await notificationService.applyQuietHours({ studioId: studioA.id, scheduledAt: nightUtc, urgent: false });
    const deferredLocal = deferred.toLocaleString('en-US', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false });
    assert.strictEqual(deferredLocal, '09:00', `deferred to 09:00 local, got ${deferredLocal}`);
    assert.ok(deferred > nightUtc, 'deferred into the future');

    // 12:00 local = 09:00 UTC -> outside quiet hours -> unchanged.
    const noonUtc = new Date('2026-11-10T09:00:00Z'); // 12:00 Istanbul
    const notDeferred = await notificationService.applyQuietHours({ studioId: studioA.id, scheduledAt: noonUtc, urgent: false });
    assert.strictEqual(notDeferred.getTime(), noonUtc.getTime(), 'daytime not deferred');

    // Urgent bypasses quiet hours.
    const urgentNight = await notificationService.applyQuietHours({ studioId: studioA.id, scheduledAt: nightUtc, urgent: true });
    assert.strictEqual(urgentNight.getTime(), nightUtc.getTime(), 'urgent bypasses quiet hours');

    // Custom quiet hours from settings.
    await StudioNotificationSettings.create({ studioId: studioA.id, quietHoursStart: '22:00', quietHoursEnd: '08:00' });
    const customNight = new Date('2026-11-10T18:30:00Z'); // 21:30 Istanbul -> outside custom 22:00-08:00
    const customNotDeferred = await notificationService.applyQuietHours({ studioId: studioA.id, scheduledAt: customNight, urgent: false });
    assert.strictEqual(customNotDeferred.getTime(), customNight.getTime(), 'custom quiet hours respected');
    console.log('Phase 3 OK: quiet-hours timezone handling + urgent bypass + custom settings');
  }

  // --- Phase 4: job processing writes inbox notifications ---
  {
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'job-process-1', urgent: true,
      payload: { notifications: [{ recipientType: 'member', recipientId: 1, title: 'Reminder', body: 'Class soon' }] },
    });
    const processed = await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    assert.ok(processed >= 1, 'job processed');
    const notif = await Notification.findOne({ where: { studioId: studioA.id, type: 'class_reminder' } });
    assert.ok(notif, 'inbox notification created');
    assert.strictEqual(notif.title, 'Reminder');
    const job = await NotificationJob.findOne({ where: { dedupKey: 'job-process-1' } });
    assert.strictEqual(job.processingState, 'done');
    assert.ok(job.processedAt);
    console.log('Phase 4 OK: job processing writes inbox notification');
  }

  // --- Phase 5: retry with backoff + failure exhaustion ---
  {
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'failing', dedupKey: 'job-fail-1', payload: {}, maxAttempts: 3, urgent: true,
    });
    let callCount = 0;
    const failingHandler = async () => { callCount += 1; throw new Error('boom'); };
    // Attempt 1
    await notificationWorker.processDueJobs({ handler: failingHandler, now: new Date(Date.now() + 60000) });
    let job = await NotificationJob.findOne({ where: { dedupKey: 'job-fail-1' } });
    assert.strictEqual(job.processingState, 'pending', 'back to pending after failure');
    assert.strictEqual(Number(job.attemptCount), 1);
    assert.ok(job.nextAttemptAt > new Date(), 'backoff scheduled');
    assert.strictEqual(job.lastError, 'boom');
    // Attempt 2 (force due)
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: failingHandler, now: new Date() });
    // Attempt 3 -> exhausted -> failed
    await job.reload();
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: failingHandler, now: new Date() });
    job = await NotificationJob.findOne({ where: { dedupKey: 'job-fail-1' } });
    assert.strictEqual(job.processingState, 'failed', 'exhausted after maxAttempts');
    assert.strictEqual(callCount, 3, 'handler called maxAttempts times');
    console.log('Phase 5 OK: retry with backoff + failure exhaustion');
  }

  // --- Phase 6: crash recovery (stale processing reclaimed) ---
  {
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'stale', dedupKey: 'job-stale-1', payload: {}, urgent: true,
    });
    const job = await NotificationJob.findOne({ where: { dedupKey: 'job-stale-1' } });
    // Simulate a crashed worker: stuck in 'processing' with old updatedAt.
    // Use a raw query so updatedAt is not auto-refreshed by Sequelize.
    await sequelize.query(
      "UPDATE NotificationJobs SET processingState='processing', updatedAt=? WHERE id=?",
      { replacements: [new Date(Date.now() - 20 * 60 * 1000).toISOString(), job.id] }
    );
    const recovered = await notificationWorker.recoverStaleJobs(new Date());
    assert.ok(recovered >= 1, 'stale job reclaimed');
    await job.reload();
    assert.strictEqual(job.processingState, 'pending', 'reclaimed to pending');
    console.log('Phase 6 OK: crash recovery reclaims stale processing jobs');
  }

  // --- Phase 7: concurrent workers cannot process the same job twice ---
  {
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'concurrent', dedupKey: 'job-conc-1', urgent: true,
      payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, title: 'T' }] },
    });
    // Two overlapping claims on the same due job: only one wins (atomic UPDATE guard).
    const now = new Date(Date.now() + 60000);
    const [c1, c2] = await Promise.all([
      notificationWorker.claimNextDueJob(now),
      notificationWorker.claimNextDueJob(now),
    ]);
    const claimedIds = [c1, c2].filter(Boolean).map((j) => Number(j.id));
    assert.strictEqual(claimedIds.length, 1, `exactly one worker claimed the job, got ${claimedIds.length}`);
    // Reset back to pending for the full-worker test below.
    await NotificationJob.update(
      { processingState: 'pending', nextAttemptAt: new Date(Date.now() - 1000) },
      { where: { dedupKey: 'job-conc-1' } }
    );

    // Two full worker runs over the same due job with the DEFAULT handler:
    // exactly one inbox notification is created (the second worker finds nothing).
    await Promise.all([
      notificationWorker.processDueJobs({ now }),
      notificationWorker.processDueJobs({ now }),
    ]);
    const notifCount = await Notification.count({ where: { studioId: studioA.id, type: 'concurrent' } });
    assert.strictEqual(notifCount, 1, 'exactly one inbox notification created across both workers');
    console.log('Phase 7 OK: concurrent workers cannot double-process');
  }

  // --- Phase 8: settings defaults ---
  {
    const settings = await StudioNotificationSettings.findOne({ where: { studioId: studioA.id } });
    assert.strictEqual(settings.quietHoursStart, '22:00'); // set in Phase 3
    // Fresh studio B has no settings row -> defaults from service.
    const defaultsB = await notificationService.getStudioNotificationSettings(studioB.id);
    assert.strictEqual(defaultsB.quietHoursStart, '21:00');
    assert.strictEqual(defaultsB.quietHoursEnd, '09:00');
    console.log('Phase 8 OK: settings defaults');
  }

  console.log('All notification-foundation cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
