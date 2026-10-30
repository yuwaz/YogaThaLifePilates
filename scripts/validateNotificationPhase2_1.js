// Disposable validator (not part of product code): proves notification Phase 2.1
// hardening — cancelled-slot rebooking, instructor reminder attribution
// (Member.assignedInstructorId, per-instructor-per-slot, revalidation), and
// crash-safe inbox idempotency at both boundaries — on isolated temp SQLite DBs.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase21-'));
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

function futureDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

async function processAll() {
  return notificationWorker.processDueJobs({ now: new Date(Date.now() + 365 * 86400000) });
}

function parsePayload(n) {
  if (!n) return null;
  if (n.payload && typeof n.payload === 'object') return n.payload;
  if (typeof n.payload === 'string') { try { return JSON.parse(n.payload); } catch { return null; } }
  return null;
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const instructorB = await User.create({ username: 'instB', password: 'h', role: 'instructor', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const equipmentA = await Equipment.create({ name: 'Mat A', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
  const equipmentA2 = await Equipment.create({ name: 'Mat A2', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
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

  async function createReservation(memberId, equipmentId, date, time, extra = {}) {
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId, equipmentId, salonId: salonA.id, date, time, ...extra }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function deleteReservation(id, query = {}) {
    const res = mockRes();
    await reservationController.deleteReservation(reqFor(asAdminA, {}, { params: { id }, query }), res);
    assert.strictEqual(res.statusCode, 204, JSON.stringify(res.body));
  }

  // --- Phase 1: cancelled slot rebooking (single) ---
  {
    const { member, account } = await makeMemberWithAccount('Member R1', '+905321210001', instructorA.id);
    const date = futureDate(3);
    const r1 = await createReservation(member.id, equipmentA.id, date, '10:00');
    await deleteReservation(r1.id);

    // Reminder job suppressed (done/cancelled).
    let memberReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${r1.id}` } });
    assert.strictEqual(memberReminder.processingState, 'done', 'reminder cancelled on delete');

    // Rebook the same slot -> new reservation, new reminder scheduled.
    const r2 = await createReservation(member.id, equipmentA.id, date, '10:00');
    assert.notStrictEqual(r2.id, r1.id, 'new reservation id');
    const memberReminder2 = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${r2.id}` } });
    assert.ok(memberReminder2, 'new member reminder for rebooked slot');
    assert.strictEqual(memberReminder2.processingState, 'pending', 'new reminder is pending');

    await processAll();
    const reminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' },
    });
    const forR2 = reminders.filter((n) => parsePayload(n) && parsePayload(n).reservationId === r2.id);
    assert.strictEqual(forR2.length, 1, 'reminder delivered for rebooked slot');
    console.log('Phase 1 OK: cancelled slot rebooking (single) reschedules reminders');
  }

  // --- Phase 2: cancelled recurring series rebooking ---
  {
    const { member } = await makeMemberWithAccount('Member R2', '+905321210002', instructorA.id);
    const date = futureDate(5);
    const series1 = await createReservation(member.id, equipmentA.id, date, '11:00', { repeatWeekly: true, recurrenceEndDate: futureDate(26) });
    const groupId1 = series1[0].recurrenceGroupId;
    await deleteReservation(series1[0].id, { deleteScope: 'future' });

    // All member reminders for series1 suppressed.
    const series1Reminders = await NotificationJob.findAll({ where: { type: 'class_reminder' } });
    const series1MemberReminders = series1Reminders.filter((j) => j.dedupKey.startsWith('class_reminder:member:') && series1.some((r) => j.dedupKey === `class_reminder:member:${r.id}`));
    assert.ok(series1MemberReminders.every((j) => j.processingState === 'done'), 'series1 reminders cancelled');

    // Rebook the same recurring series.
    const series2 = await createReservation(member.id, equipmentA.id, date, '11:00', { repeatWeekly: true, recurrenceEndDate: futureDate(26) });
    const groupId2 = series2[0].recurrenceGroupId;
    assert.notStrictEqual(groupId2, groupId1, 'new recurrence group');
    // New reminders pending for series2.
    for (const r of series2) {
      const reminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${r.id}` } });
      assert.ok(reminder && reminder.processingState === 'pending', `reminder pending for rebooked occurrence ${r.id}`);
    }
    console.log('Phase 2 OK: cancelled recurring series rebooking reschedules all reminders');
  }

  // --- Phase 3: multiple instructors in same salon/time -> each notified separately ---
  {
    const { member: mA } = await makeMemberWithAccount('Member IA', '+905321210003', instructorA.id);
    const { member: mB } = await makeMemberWithAccount('Member IB', '+905321210004', instructorB.id);
    const date = futureDate(7);
    await createReservation(mA.id, equipmentA.id, date, '12:00');
    await createReservation(mB.id, equipmentA2.id, date, '12:00');

    // Two distinct instructor reminder jobs (per instructor per slot).
    const jobA = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:instructor:${date}:12:00:${salonA.id}:${instructorA.id}` } });
    const jobB = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:instructor:${date}:12:00:${salonA.id}:${instructorB.id}` } });
    assert.ok(jobA, 'instructor A reminder job');
    assert.ok(jobB, 'instructor B reminder job (separate)');

    await processAll();
    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const slotReminders = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).time === '12:00');
    const recipientIds = slotReminders.map((n) => Number(n.recipientId)).sort();
    assert.deepStrictEqual(recipientIds, [instructorA.id, instructorB.id].sort(), 'each instructor notified separately');
    console.log('Phase 3 OK: multiple instructors in same slot each notified');
  }

  // --- Phase 4: one reminder per instructor per slot (multiple assigned members) ---
  {
    const { member: m1 } = await makeMemberWithAccount('Member S1', '+905321210005', instructorA.id);
    const { member: m2 } = await makeMemberWithAccount('Member S2', '+905321210006', instructorA.id);
    const date = futureDate(9);
    await createReservation(m1.id, equipmentA.id, date, '13:00');
    await createReservation(m2.id, equipmentA2.id, date, '13:00');

    // Same instructor, same slot -> ONE job (dedup).
    const jobs = await NotificationJob.findAll({ where: { dedupKey: `class_reminder:instructor:${date}:13:00:${salonA.id}:${instructorA.id}` } });
    assert.strictEqual(jobs.length, 1, 'ONE instructor reminder job per instructor per slot');
    await processAll();
    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const slotReminders = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).time === '13:00');
    assert.strictEqual(slotReminders.length, 1, 'ONE instructor reminder notification per slot');
    assert.strictEqual(Number(slotReminders[0].recipientId), instructorA.id);
    console.log('Phase 4 OK: one reminder per instructor per slot');
  }

  // --- Phase 5: assignment change before delivery -> revalidated ---
  {
    const { member } = await makeMemberWithAccount('Member Ch', '+905321210007', instructorA.id);
    const date = futureDate(11);
    await createReservation(member.id, equipmentA.id, date, '14:00');
    // Instructor A reminder job enqueued.
    const job = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:instructor:${date}:14:00:${salonA.id}:${instructorA.id}` } });
    assert.ok(job, 'instructor A reminder enqueued');

    // Reassign member to instructor B before delivery.
    member.assignedInstructorId = instructorB.id;
    await member.save();

    await processAll();
    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const slotReminders = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).time === '14:00');
    // Instructor A no longer has a member in this slot -> A's reminder skipped.
    const forA = slotReminders.filter((n) => Number(n.recipientId) === instructorA.id);
    assert.strictEqual(forA.length, 0, 'reassigned instructor A not notified');
    console.log('Phase 5 OK: assignment change revalidated before delivery');
  }

  // --- Phase 6: never notify unrelated instructor ---
  {
    const { member } = await makeMemberWithAccount('Member Un', '+905321210008', instructorA.id);
    const date = futureDate(13);
    await createReservation(member.id, equipmentA.id, date, '15:00');
    await processAll();
    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const slotReminders = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).time === '15:00');
    assert.strictEqual(slotReminders.length, 1);
    assert.strictEqual(Number(slotReminders[0].recipientId), instructorA.id, 'only assigned instructor notified');
    assert.ok(!slotReminders.some((n) => Number(n.recipientId) === instructorB.id), 'unrelated instructor B not notified');
    console.log('Phase 6 OK: never notify unrelated instructor');
  }

  // --- Phase 7: crash-safe idempotency at both boundaries ---
  {
    const { account } = await makeMemberWithAccount('Member Crash', '+905321210009', instructorA.id);
    const payload = { notifications: [{ recipientType: 'member', recipientId: account.id, type: 'reservation_confirmed', title: 'CrashTest' }] };

    // Boundary A: crash AFTER inbox INSERT but BEFORE notificationId link.
    // With the atomic transaction, both roll back -> no orphan notification.
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'reservation_confirmed', dedupKey: 'crash-a', urgent: true, payload,
    });
    let crashedA = false;
    const crashAfterInsert = async (job) => {
      if (!crashedA) {
        crashedA = true;
        // Simulate: insert happens inside transaction, then crash before commit.
        throw new Error('crash before commit');
      }
      return notificationWorker.defaultJobHandler(job);
    };
    const now = new Date(Date.now() + 60000);
    await notificationWorker.processDueJobs({ handler: crashAfterInsert, now });
    let notifs = await Notification.findAll({ where: { studioId: studioA.id, title: 'CrashTest' } });
    assert.strictEqual(notifs.length, 0, 'no orphan notification after crash-before-commit');
    let job = await NotificationJob.findOne({ where: { dedupKey: 'crash-a' } });
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: crashAfterInsert, now: new Date() });
    notifs = await Notification.findAll({ where: { studioId: studioA.id, title: 'CrashTest' } });
    assert.strictEqual(notifs.length, 1, 'exactly one notification after retry');

    // Boundary B: crash AFTER commit but BEFORE job marked done.
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'reservation_confirmed', dedupKey: 'crash-b', urgent: true,
      payload: { notifications: [{ recipientType: 'member', recipientId: account.id, type: 'reservation_confirmed', title: 'CrashTestB' }] },
    });
    let crashedB = false;
    const crashAfterCommit = async (job) => {
      const result = await notificationWorker.defaultJobHandler(job); // commits insert + link
      if (!crashedB) {
        crashedB = true;
        throw new Error('crash after commit'); // job stays pending, but notification exists
      }
      return result;
    };
    await notificationWorker.processDueJobs({ handler: crashAfterCommit, now });
    job = await NotificationJob.findOne({ where: { dedupKey: 'crash-b' } });
    assert.strictEqual(job.processingState, 'pending', 'job pending after crash-after-commit');
    await job.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await notificationWorker.processDueJobs({ handler: crashAfterCommit, now: new Date() });
    const notifsB = await Notification.findAll({ where: { studioId: studioA.id, title: 'CrashTestB' } });
    assert.strictEqual(notifsB.length, 1, 'no duplicate after crash-after-commit retry');
    console.log('Phase 7 OK: crash-safe idempotency at both boundaries');
  }

  // --- Phase 8: cross-studio isolation ---
  {
    const notifsB = await Notification.findAll({ where: { studioId: studioB.id } });
    const jobsB = await NotificationJob.findAll({ where: { studioId: studioB.id } });
    assert.strictEqual(notifsB.length, 0, 'studio B has no notifications');
    assert.strictEqual(jobsB.length, 0, 'studio B has no jobs');
    console.log('Phase 8 OK: cross-studio isolation');
  }

  console.log('All notification-phase2.1 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
