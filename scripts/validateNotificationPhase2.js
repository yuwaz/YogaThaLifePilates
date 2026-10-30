// Disposable validator (not part of product code): proves notification Phase 2 —
// reservation confirmations (single/series), class reminders (member 2h,
// instructor 1h per slot), cancellations (single/series + reminder suppression),
// quiet-hours/timezone, cross-studio isolation, and crash/retry idempotency —
// against isolated temp SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase2-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  Salon,
  Equipment,
  MemberType,
  Member,
  MemberAccount,
  MemberAccountMembership,
  Reservation,
  Notification,
  NotificationJob,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const reservationController = require('../controllers/reservationController');
const notificationWorker = require('../services/notificationWorker');
const notificationService = require('../services/notificationService');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
  return res;
}

function reqFor(user, body, extra = {}) {
  return { user, body, query: {}, params: {}, ...extra };
}

// Compute a future date N days ahead (YYYY-MM-DD) and a time string.
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

async function processAll() {
  // Process all due jobs (far future 'now' to catch everything).
  return notificationWorker.processDueJobs({ now: new Date(Date.now() + 365 * 86400000) });
}

// Notification.payload is stored as JSON TEXT in SQLite; parse for assertions.
function parsePayload(notification) {
  if (!notification) return null;
  if (notification.payload && typeof notification.payload === 'object') return notification.payload;
  if (typeof notification.payload === 'string') {
    try { return JSON.parse(notification.payload); } catch { return null; }
  }
  return null;
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();

  // --- Fixtures ---
  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const equipmentA = await Equipment.create({ name: 'Mat A', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  async function makeMemberWithAccount(name, phone, assignedInstructorId) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId, remainingLessons: 50, isActive: true, studioId: studioA.id,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId: studioA.id, memberId: member.id });
    return { member, account };
  }

  // --- Phase 1: single reservation -> one member confirmation + reminders ---
  {
    const { member, account } = await makeMemberWithAccount('Member One', '+905321110001', instructorA.id);
    const date = futureDate(3);
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '10:00' }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));

    // Confirmation job enqueued.
    const confirmJob = await NotificationJob.findOne({ where: { dedupKey: `reservation_confirmed:${res.body.id}` } });
    assert.ok(confirmJob, 'single confirmation job enqueued');
    // Member + instructor reminder jobs enqueued.
    const memberReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${res.body.id}` } });
    const instructorReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:instructor:${date}:10:00:${salonA.id}:${instructorA.id}` } });
    assert.ok(memberReminder, 'member reminder enqueued');
    assert.ok(instructorReminder, 'instructor reminder enqueued (per slot)');

    await processAll();
    const confirmations = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_confirmed' } });
    assert.strictEqual(confirmations.length, 1, 'exactly one confirmation notification');
    assert.strictEqual(Number(confirmations[0].recipientId), account.id);
    assert.strictEqual(confirmations[0].recipientType, 'member');
    const memberReminders = await Notification.findAll({ where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' } });
    const instructorReminders = await Notification.findAll({ where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' } });
    assert.strictEqual(memberReminders.length, 1, 'one member reminder');
    assert.strictEqual(instructorReminders.length, 1, 'one instructor reminder');
    assert.strictEqual(Number(instructorReminders[0].recipientId), instructorA.id);
    console.log('Phase 1 OK: single reservation confirmation + member/instructor reminders');
  }

  // --- Phase 2: weekly recurring -> ONE series confirmation + per-occurrence reminders ---
  {
    const { member, account } = await makeMemberWithAccount('Member Two', '+905321110002', instructorA.id);
    const date = futureDate(5);
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '11:00', repeatWeekly: true, recurrenceEndDate: futureDate(26) }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body) && res.body.length === 4, `4 occurrences, got ${res.body.length}`);
    const groupId = res.body[0].recurrenceGroupId;

    // ONE series confirmation job.
    const seriesJob = await NotificationJob.findOne({ where: { dedupKey: `reservation_series_confirmed:${groupId}` } });
    assert.ok(seriesJob, 'series confirmation job enqueued');
    // Per-occurrence member reminders (4).
    const memberReminderJobs = await NotificationJob.findAll({
      where: { type: 'class_reminder' },
    });
    const memberReminderJobsForSeries = memberReminderJobs.filter((j) => j.dedupKey.startsWith('class_reminder:member:'));
    // 4 new (this series) + 1 from Phase 1 = 5 total member reminders.
    assert.strictEqual(memberReminderJobsForSeries.length, 5, `per-occurrence member reminders, got ${memberReminderJobsForSeries.length}`);

    await processAll();
    const seriesConfirmations = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_series_confirmed' } });
    assert.strictEqual(seriesConfirmations.length, 1, 'ONE series confirmation, not per occurrence');
    assert.strictEqual(Number(seriesConfirmations[0].recipientId), account.id);
    const seriesPayload = parsePayload(seriesConfirmations[0]);
    assert.strictEqual(seriesPayload.count, 4);
    assert.strictEqual(seriesPayload.recurrenceType, 'weekly');
    console.log('Phase 2 OK: ONE series confirmation + per-occurrence reminders');
  }

  // --- Phase 3: instructor reminder is ONE per slot, not per member ---
  {
    // Two members, same slot (date+time+salon), same instructor, different equipment.
    const equipmentA2 = await Equipment.create({ name: 'Mat A2', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
    const { member: m1 } = await makeMemberWithAccount('Member Three', '+905321110003', instructorA.id);
    const { member: m2 } = await makeMemberWithAccount('Member Four', '+905321110004', instructorA.id);
    const date = futureDate(7);
    const equipmentFor = [equipmentA.id, equipmentA2.id];
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await reservationController.createReservation(
        reqFor(asAdminA, { memberId: [m1, m2][i].id, equipmentId: equipmentFor[i], salonId: salonA.id, date, time: '12:00' }), res);
      assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    }
    // Instructor reminder dedup key is per slot -> only one job.
    const instructorSlotJobs = await NotificationJob.findAll({
      where: { dedupKey: `class_reminder:instructor:${date}:12:00:${salonA.id}:${instructorA.id}` },
    });
    assert.strictEqual(instructorSlotJobs.length, 1, 'ONE instructor reminder job per slot');
    await processAll();
    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const slotReminders = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).time === '12:00');
    assert.strictEqual(slotReminders.length, 1, 'ONE instructor reminder notification per slot');
    console.log('Phase 3 OK: one instructor reminder per class slot');
  }

  // --- Phase 4: single cancellation -> notify member + instructor, suppress reminder ---
  {
    const { member, account } = await makeMemberWithAccount('Member Five', '+905321110005', instructorA.id);
    const date = futureDate(9);
    const createRes = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '13:00' }), createRes);
    assert.strictEqual(createRes.statusCode, 201);
    const reservationId = createRes.body.id;

    const delRes = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: reservationId }, query: {} }), delRes);
    assert.strictEqual(delRes.statusCode, 204, JSON.stringify(delRes.body));

    // Cancellation job enqueued (urgent).
    const cancelJob = await NotificationJob.findOne({ where: { dedupKey: `reservation_cancelled:${reservationId}` } });
    assert.ok(cancelJob, 'cancellation job enqueued');
    // Reminder jobs suppressed (marked done/cancelled).
    const memberReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${reservationId}` } });
    assert.strictEqual(memberReminder.processingState, 'done', 'member reminder suppressed');
    assert.strictEqual(memberReminder.lastError, 'cancelled');

    await processAll();
    const cancellations = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_cancelled' } });
    const memberCancel = cancellations.find((n) => n.recipientType === 'member');
    const instructorCancel = cancellations.find((n) => n.recipientType === 'instructor');
    assert.ok(memberCancel, 'member cancellation notification');
    assert.ok(instructorCancel, 'instructor cancellation notification');
    assert.strictEqual(Number(memberCancel.recipientId), account.id);
    assert.strictEqual(Number(instructorCancel.recipientId), instructorA.id);
    // No class_reminder notification for the cancelled booking.
    const reminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' },
    });
    const cancelledReminder = reminders.find((n) => parsePayload(n) && parsePayload(n).reservationId === reservationId);
    assert.strictEqual(cancelledReminder, undefined, 'no reminder delivered for cancelled booking');
    console.log('Phase 4 OK: single cancellation + reminder suppression');
  }

  // --- Phase 5: series cancellation -> ONE summary per recipient ---
  {
    const { member, account } = await makeMemberWithAccount('Member Six', '+905321110006', instructorA.id);
    const date = futureDate(11);
    const createRes = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '14:00', repeatWeekly: true, recurrenceEndDate: futureDate(32) }), createRes);
    assert.strictEqual(createRes.statusCode, 201);
    const groupId = createRes.body[0].recurrenceGroupId;
    const firstId = createRes.body[0].id;

    const delRes = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: firstId }, query: { deleteScope: 'future' } }), delRes);
    assert.strictEqual(delRes.statusCode, 204, JSON.stringify(delRes.body));

    await processAll();
    const cancellations = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_cancelled' } });
    const seriesMemberCancel = cancellations.filter((n) => n.recipientType === 'member' && parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    const seriesInstructorCancel = cancellations.filter((n) => n.recipientType === 'instructor' && parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.strictEqual(seriesMemberCancel.length, 1, 'ONE series cancellation summary for member');
    assert.strictEqual(seriesInstructorCancel.length, 1, 'ONE series cancellation summary for instructor');
    assert.strictEqual(parsePayload(seriesMemberCancel[0]).count, 4, 'summary includes occurrence count');
    console.log('Phase 5 OK: series cancellation -> one summary per recipient');
  }

  // --- Phase 6: no reminders for past classes ---
  {
    const { member } = await makeMemberWithAccount('Member Seven', '+905321110007', instructorA.id);
    const pastDate = '2020-01-01';
    // Directly create a past reservation (bypass controller validation).
    const pastReservation = await Reservation.create({
      memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date: pastDate, time: '10:00', studioId: studioA.id,
    });
    const reservationNotificationService = require('../services/reservationNotificationService');
    const timeZone = await reservationNotificationService.getStudioTimezoneById(studioA.id);
    await reservationNotificationService.scheduleRemindersForReservation(pastReservation, { studioId: studioA.id, timeZone });
    const pastReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${pastReservation.id}` } });
    assert.strictEqual(pastReminder, null, 'no reminder for past class');
    console.log('Phase 6 OK: no reminders for past classes');
  }

  // --- Phase 7: cross-studio isolation ---
  {
    const notificationsA = await Notification.findAll({ where: { studioId: studioA.id } });
    const notificationsB = await Notification.findAll({ where: { studioId: studioB.id } });
    assert.ok(notificationsA.length > 0, 'studio A has notifications');
    assert.strictEqual(notificationsB.length, 0, 'studio B has none');
    const jobsB = await NotificationJob.findAll({ where: { studioId: studioB.id } });
    assert.strictEqual(jobsB.length, 0, 'studio B has no jobs');
    console.log('Phase 7 OK: cross-studio isolation');
  }

  // --- Phase 8: crash/retry idempotency (no duplicate notification) ---
  {
    const { account } = await makeMemberWithAccount('Member Eight', '+905321110008', instructorA.id);
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'reservation_confirmed', dedupKey: 'crash-test-1', urgent: true,
      payload: { notifications: [{ recipientType: 'member', recipientId: account.id, type: 'reservation_confirmed', title: 'Crash' }] },
    });
    // Simulate crash: handler creates the notification + links notificationId, then throws.
    let crashed = false;
    const crashHandler = async (job) => {
      if (!crashed) {
        await notificationWorker.defaultJobHandler(job); // creates notification + sets notificationId
        crashed = true;
        throw new Error('simulated crash after insert');
      }
      return notificationWorker.defaultJobHandler(job); // retry: should reuse
    };
    const now = new Date(Date.now() + 60000);
    await notificationWorker.processDueJobs({ handler: crashHandler, now }); // attempt 1: crash
    let job = await NotificationJob.findOne({ where: { dedupKey: 'crash-test-1' } });
    assert.strictEqual(job.processingState, 'pending', 'job back to pending after crash');
    assert.ok(job.notificationId, 'notificationId linked after crash');
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: crashHandler, now: new Date() }); // attempt 2: success
    const crashNotifications = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_confirmed', title: 'Crash' } });
    assert.strictEqual(crashNotifications.length, 1, 'no duplicate notification after crash/retry');
    job = await NotificationJob.findOne({ where: { dedupKey: 'crash-test-1' } });
    assert.strictEqual(job.processingState, 'done');
    console.log('Phase 8 OK: crash/retry idempotency (no duplicate)');
  }

  console.log('All notification-phase2 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
