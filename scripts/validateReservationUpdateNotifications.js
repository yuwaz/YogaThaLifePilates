// Disposable validator (not part of product code): focused regression coverage
// for reservation date/time change notifications and reminder consistency —
// single update, future-scope series update, single->weekly conversion, old/new
// values in member + instructor notifications, obsolete reminder cancellation,
// no duplicate reminders, instructor slot reminders preserved for remaining
// attendees and other instructors sharing the slot, tenant isolation and
// idempotency — against an isolated temp SQLite DB. Does not touch the real
// database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-update-'));
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
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

async function processAll() {
  return notificationWorker.processDueJobs({ now: new Date(Date.now() + 365 * 86400000) });
}

function parsePayload(notification) {
  if (!notification) return null;
  if (notification.payload && typeof notification.payload === 'object') return notification.payload;
  if (typeof notification.payload === 'string') {
    try { return JSON.parse(notification.payload); } catch { return null; }
  }
  return null;
}

async function jobByKey(dedupKey) {
  return NotificationJob.findOne({ where: { dedupKey } });
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

  async function createSingle(member, date, time, equipment = equipmentA) {
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipment.id, salonId: salonA.id, date, time }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function updateSingle(id, member, date, time, extra = {}) {
    const res = mockRes();
    await reservationController.updateReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time, ...extra }, { params: { id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function updatedNotifs(reservationId) {
    const all = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_updated' } });
    return all.filter((n) => parsePayload(n) && parsePayload(n).reservationId === reservationId);
  }

  // --- U1: single date/time change -> member + instructor notified, reminders rescheduled ---
  {
    const { member, account } = await makeMemberWithAccount('U1 Member', '+905422220001', instructorA.id);
    const oldDate = futureDate(3);
    const newDate = futureDate(4);
    const created = await createSingle(member, oldDate, '10:00');
    const id = created.id;

    await updateSingle(id, member, newDate, '11:00');

    // Old reminders cancelled, new reminders scheduled.
    const memberReminder = await jobByKey(`class_reminder:member:${id}`);
    assert.strictEqual(memberReminder.processingState, 'pending', 'member reminder rescheduled (pending)');
    const oldInstructorReminder = await jobByKey(`class_reminder:instructor:${oldDate}:10:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(oldInstructorReminder.processingState, 'done', 'old instructor slot reminder cancelled');
    assert.strictEqual(oldInstructorReminder.lastError, 'cancelled');
    const newInstructorReminder = await jobByKey(`class_reminder:instructor:${newDate}:11:00:${salonA.id}:${instructorA.id}`);
    assert.ok(newInstructorReminder, 'new instructor slot reminder scheduled');
    assert.strictEqual(newInstructorReminder.processingState, 'pending');

    await processAll();
    const notifs = await updatedNotifs(id);
    const memberN = notifs.find((n) => n.recipientType === 'member');
    const instructorN = notifs.find((n) => n.recipientType === 'instructor');
    assert.ok(memberN && instructorN, 'member + instructor update notifications');
    assert.strictEqual(Number(memberN.recipientId), account.id);
    assert.strictEqual(Number(instructorN.recipientId), instructorA.id);
    assert.strictEqual(memberN.title, 'Rezervasyon Güncellendi');
    assert.strictEqual(instructorN.title, 'Rezervasyon Güncellendi');
    assert.ok(memberN.body.includes(oldDate) && memberN.body.includes('10:00'), 'member body has old values');
    assert.ok(memberN.body.includes(newDate) && memberN.body.includes('11:00'), 'member body has new values');
    assert.ok(instructorN.body.includes('U1 Member'), 'instructor body names the member');
    assert.ok(instructorN.body.includes(oldDate) && instructorN.body.includes('10:00'), 'instructor body has old values');
    assert.ok(instructorN.body.includes(newDate) && instructorN.body.includes('11:00'), 'instructor body has new values');
    assert.ok(instructorN.body.includes('Salon A'), 'instructor body has salon');
    const p = parsePayload(instructorN);
    assert.strictEqual(p.oldDate, oldDate);
    assert.strictEqual(p.oldTime, '10:00');
    assert.strictEqual(p.newDate, newDate);
    assert.strictEqual(p.newTime, '11:00');
    assert.strictEqual(p.memberName, 'U1 Member');
    assert.strictEqual(p.salonName, 'Salon A');

    // Reminders delivered for the NEW slot only.
    const reminders = await Notification.findAll({ where: { studioId: studioA.id, type: 'class_reminder' } });
    const memberReminderN = reminders.find((n) => n.recipientType === 'member' && parsePayload(n) && parsePayload(n).reservationId === id);
    assert.ok(memberReminderN, 'member reminder delivered');
    assert.strictEqual(parsePayload(memberReminderN).date, newDate, 'member reminder has new date');
    assert.strictEqual(parsePayload(memberReminderN).time, '11:00', 'member reminder has new time');
    const instructorReminderN = reminders.find((n) => n.recipientType === 'instructor' && parsePayload(n) && parsePayload(n).date === newDate && parsePayload(n).time === '11:00');
    assert.ok(instructorReminderN, 'instructor reminder delivered for new slot');
    const staleInstructorReminderN = reminders.find((n) => n.recipientType === 'instructor' && parsePayload(n) && parsePayload(n).date === oldDate && parsePayload(n).time === '10:00');
    assert.strictEqual(staleInstructorReminderN, undefined, 'no instructor reminder for old slot');
    console.log('U1 OK: single date/time change -> notifications + reminder reschedule');
  }

  // --- U2: no date/time change -> no notification, reminders untouched ---
  {
    const { member } = await makeMemberWithAccount('U2 Member', '+905422220002', instructorA.id);
    const date = futureDate(6);
    const created = await createSingle(member, date, '12:00');
    const id = created.id;

    await updateSingle(id, member, date, '12:00'); // same date/time

    const memberReminder = await jobByKey(`class_reminder:member:${id}`);
    assert.strictEqual(memberReminder.processingState, 'pending', 'member reminder untouched');
    const instructorReminder = await jobByKey(`class_reminder:instructor:${date}:12:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(instructorReminder.processingState, 'pending', 'instructor reminder untouched');
    await processAll();
    const notifs = await updatedNotifs(id);
    assert.strictEqual(notifs.length, 0, 'no update notification without date/time change');
    console.log('U2 OK: no date/time change -> no notification, reminders untouched');
  }

  // --- U3: future-scope time change -> per-occurrence notifications + reminder reschedule ---
  {
    const { member, account } = await makeMemberWithAccount('U3 Member', '+905422220003', instructorA.id);
    const date = futureDate(8);
    const createRes = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '13:00', repeatWeekly: true, recurrenceEndDate: futureDate(29) }), createRes);
    assert.strictEqual(createRes.statusCode, 201, JSON.stringify(createRes.body));
    assert.strictEqual(createRes.body.length, 4, '4 occurrences');
    const occurrences = createRes.body;

    // Future-scope update from occurrence 2: time 13:00 -> 13:30 (dates unchanged).
    const res = mockRes();
    await reservationController.updateReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date: occurrences[1].date, time: '13:30', updateScope: 'future' }, { params: { id: occurrences[1].id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.length, 3, '3 future occurrences updated');

    // Reminders: occurrence 0 untouched; occurrences 1-3 rescheduled.
    const untouchedMemberReminder = await jobByKey(`class_reminder:member:${occurrences[0].id}`);
    assert.strictEqual(untouchedMemberReminder.processingState, 'pending', 'occurrence before scope untouched');
    const untouchedInstructorReminder = await jobByKey(`class_reminder:instructor:${occurrences[0].date}:13:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(untouchedInstructorReminder.processingState, 'pending', 'old-slot instructor reminder kept (occurrence 0 still attends)');
    for (const occ of occurrences.slice(1)) {
      const memberReminder = await jobByKey(`class_reminder:member:${occ.id}`);
      assert.strictEqual(memberReminder.processingState, 'pending', `member reminder rescheduled for ${occ.date}`);
      const newInstructorReminder = await jobByKey(`class_reminder:instructor:${occ.date}:13:30:${salonA.id}:${instructorA.id}`);
      assert.ok(newInstructorReminder, `new instructor reminder for ${occ.date} 13:30`);
    }

    await processAll();
    for (const occ of occurrences.slice(1)) {
      const notifs = await updatedNotifs(occ.id);
      const memberN = notifs.find((n) => n.recipientType === 'member');
      const instructorN = notifs.find((n) => n.recipientType === 'instructor');
      assert.ok(memberN && instructorN, `update notifications for occurrence ${occ.id}`);
      assert.strictEqual(Number(memberN.recipientId), account.id);
      const p = parsePayload(memberN);
      assert.strictEqual(p.oldDate, occ.date, 'date unchanged');
      assert.strictEqual(p.oldTime, '13:00');
      assert.strictEqual(p.newDate, occ.date);
      assert.strictEqual(p.newTime, '13:30');
    }
    // No notification for the occurrence before the scope.
    const beforeScope = await updatedNotifs(occurrences[0].id);
    assert.strictEqual(beforeScope.length, 0, 'no notification before scope');
    console.log('U3 OK: future-scope time change -> per-occurrence notifications + reminders');
  }

  // --- U4: single -> weekly conversion -> update notification + series confirmation + reminders ---
  {
    const { member } = await makeMemberWithAccount('U4 Member', '+905422220004', instructorA.id);
    const oldDate = futureDate(12);
    const newDate = futureDate(13);
    const created = await createSingle(member, oldDate, '14:00');
    const id = created.id;

    const res = mockRes();
    await reservationController.updateReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date: newDate, time: '14:30', repeatWeekly: true }, { params: { id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body) && res.body.length === 156, `156 occurrences, got ${res.body.length}`);
    const groupId = res.body[0].recurrenceGroupId;

    // Old-slot reminders cancelled; new-slot reminders scheduled for all occurrences.
    const oldInstructorReminder = await jobByKey(`class_reminder:instructor:${oldDate}:14:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(oldInstructorReminder.processingState, 'done', 'old instructor slot reminder cancelled');
    const firstNewInstructorReminder = await jobByKey(`class_reminder:instructor:${newDate}:14:30:${salonA.id}:${instructorA.id}`);
    assert.ok(firstNewInstructorReminder, 'new instructor slot reminder scheduled');
    const memberReminder = await jobByKey(`class_reminder:member:${id}`);
    assert.strictEqual(memberReminder.processingState, 'pending', 'member reminder rescheduled to new slot');

    await processAll();
    const notifs = await updatedNotifs(id);
    const memberN = notifs.find((n) => n.recipientType === 'member');
    const instructorN = notifs.find((n) => n.recipientType === 'instructor');
    assert.ok(memberN && instructorN, 'update notifications for converted reservation');
    const p = parsePayload(instructorN);
    assert.strictEqual(p.oldDate, oldDate);
    assert.strictEqual(p.oldTime, '14:00');
    assert.strictEqual(p.newDate, newDate);
    assert.strictEqual(p.newTime, '14:30');
    // Series confirmation still sent (member + instructor).
    const series = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_series_confirmed' } });
    const seriesForGroup = series.filter((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.strictEqual(seriesForGroup.filter((n) => n.recipientType === 'member').length, 1, 'member series confirmation');
    assert.strictEqual(seriesForGroup.filter((n) => n.recipientType === 'instructor').length, 1, 'instructor series confirmation');
    console.log('U4 OK: single -> weekly conversion -> update + series confirmation + reminders');
  }

  // --- U5: moving one member preserves instructor reminders for remaining attendees ---
  {
    const { member: m1 } = await makeMemberWithAccount('U5 Member One', '+905422220005', instructorA.id);
    const { member: m2 } = await makeMemberWithAccount('U5 Member Two', '+905422220006', instructorA.id);
    const date = futureDate(16);
    const r1 = await createSingle(m1, date, '15:00', equipmentA);
    await createSingle(m2, date, '15:00', equipmentA2); // same slot, same instructor

    // Move m1 to a different time.
    await updateSingle(r1.id, m1, date, '15:30');

    // Instructor slot reminder for 15:00 must survive (m2 still attends).
    const slotReminder = await jobByKey(`class_reminder:instructor:${date}:15:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(slotReminder.processingState, 'pending', 'instructor slot reminder preserved for remaining attendee');
    const newSlotReminder = await jobByKey(`class_reminder:instructor:${date}:15:30:${salonA.id}:${instructorA.id}`);
    assert.ok(newSlotReminder, 'new slot reminder scheduled for moved member');
    console.log('U5 OK: moving one member preserves instructor reminder for remaining attendees');
  }

  // --- U6: cancelling one member preserves reminders for other instructors sharing the slot ---
  {
    const { member: m1 } = await makeMemberWithAccount('U6 Member One', '+905422220007', instructorA.id);
    const { member: m2 } = await makeMemberWithAccount('U6 Member Two', '+905422220008', instructorB.id);
    const date = futureDate(18);
    const r1 = await createSingle(m1, date, '16:00', equipmentA);
    await createSingle(m2, date, '16:00', equipmentA2); // same slot, DIFFERENT instructor

    const reminderA = await jobByKey(`class_reminder:instructor:${date}:16:00:${salonA.id}:${instructorA.id}`);
    const reminderB = await jobByKey(`class_reminder:instructor:${date}:16:00:${salonA.id}:${instructorB.id}`);
    assert.ok(reminderA && reminderB, 'both instructor slot reminders exist');

    // Cancel m1's reservation.
    const delRes = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: r1.id }, query: {} }), delRes);
    assert.strictEqual(delRes.statusCode, 204, JSON.stringify(delRes.body));

    const reminderAAfter = await jobByKey(`class_reminder:instructor:${date}:16:00:${salonA.id}:${instructorA.id}`);
    const reminderBAfter = await jobByKey(`class_reminder:instructor:${date}:16:00:${salonA.id}:${instructorB.id}`);
    assert.strictEqual(reminderAAfter.processingState, 'pending', 'cancelling member instructor reminder preserved (slot still attended)');
    assert.strictEqual(reminderBAfter.processingState, 'pending', 'other instructor slot reminder preserved');
    console.log('U6 OK: cancellation preserves instructor reminders for remaining attendees/other instructors');
  }

  // --- U7: last attendee cancellation cancels the instructor slot reminder ---
  {
    const { member } = await makeMemberWithAccount('U7 Member', '+905422220009', instructorA.id);
    const date = futureDate(20);
    const created = await createSingle(member, date, '17:00');

    const delRes = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: created.id }, query: {} }), delRes);
    assert.strictEqual(delRes.statusCode, 204, JSON.stringify(delRes.body));

    const slotReminder = await jobByKey(`class_reminder:instructor:${date}:17:00:${salonA.id}:${instructorA.id}`);
    assert.strictEqual(slotReminder.processingState, 'done', 'instructor slot reminder cancelled when slot empties');
    assert.strictEqual(slotReminder.lastError, 'cancelled');
    console.log('U7 OK: last attendee cancellation cancels instructor slot reminder');
  }

  // --- U8: idempotency + tenant isolation ---
  {
    const { member } = await makeMemberWithAccount('U8 Member', '+905422220010', instructorA.id);
    const oldDate = futureDate(22);
    const newDate = futureDate(23);
    const created = await createSingle(member, oldDate, '18:00');
    const id = created.id;

    await updateSingle(id, member, newDate, '18:30');
    await processAll();
    // Re-enqueue the SAME logical update (same updateId) -> deduped, no duplicate.
    const reservationNotificationService = require('../services/reservationNotificationService');
    const timeZone = await reservationNotificationService.getStudioTimezoneById(studioA.id);
    await reservationNotificationService.notifyReservationUpdated([{
      reservationId: id, memberId: member.id, salonId: salonA.id,
      oldDate: oldDate, oldTime: '18:00', newDate: newDate, newTime: '18:30',
      updateId: 'upd-dedup-guard',
    }], { studioId: studioA.id, timeZone });
    await reservationNotificationService.notifyReservationUpdated([{
      reservationId: id, memberId: member.id, salonId: salonA.id,
      oldDate: oldDate, oldTime: '18:00', newDate: newDate, newTime: '18:30',
      updateId: 'upd-dedup-guard',
    }], { studioId: studioA.id, timeZone });
    const dedupJobs = await NotificationJob.findAll({ where: { dedupKey: `reservation_updated:${id}:upd-dedup-guard` } });
    assert.strictEqual(dedupJobs.length, 1, 'duplicate enqueue with same updateId deduped to one job');
    await processAll();

    const notifs = await updatedNotifs(id);
    assert.strictEqual(notifs.filter((n) => n.recipientType === 'member').length, 2, 'one member notification per distinct update event');
    assert.strictEqual(notifs.filter((n) => n.recipientType === 'instructor').length, 2, 'one instructor notification per distinct update event');
    const memberReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' },
    });
    const forReservation = memberReminders.filter((n) => parsePayload(n) && parsePayload(n).reservationId === id);
    assert.strictEqual(forReservation.length, 1, 'no duplicate member reminder');

    // Tenant isolation: nothing leaked to studio B.
    const notifsB = await Notification.findAll({ where: { studioId: studioB.id } });
    assert.strictEqual(notifsB.length, 0, 'studio B has no notifications');
    const jobsB = await NotificationJob.findAll({ where: { studioId: studioB.id } });
    assert.strictEqual(jobsB.length, 0, 'studio B has no jobs');
    console.log('U8 OK: idempotency + tenant isolation');
  }

  // --- U9: repeated moves A->B->A->B -> every change notifies, reminders consistent ---
  {
    const { member, account } = await makeMemberWithAccount('U9 Member', '+905422220011', instructorA.id);
    const dateA = futureDate(30);
    const dateB = futureDate(31);
    const created = await createSingle(member, dateA, '09:00');
    const id = created.id;

    // A -> B -> A -> B (three updates; the third returns to B, colliding with
    // the first update's destination under the old destination-based dedup key).
    await updateSingle(id, member, dateB, '09:30');
    await updateSingle(id, member, dateA, '09:00');
    await updateSingle(id, member, dateB, '09:30');
    await processAll();

    const notifs = await updatedNotifs(id);
    const memberNotifs = notifs.filter((n) => n.recipientType === 'member');
    const instructorNotifs = notifs.filter((n) => n.recipientType === 'instructor');
    assert.strictEqual(memberNotifs.length, 3, `ALL three moves notified the member, got ${memberNotifs.length}`);
    assert.strictEqual(instructorNotifs.length, 3, `ALL three moves notified the instructor, got ${instructorNotifs.length}`);
    assert.ok(memberNotifs.every((n) => Number(n.recipientId) === account.id), 'member recipient');
    assert.ok(instructorNotifs.every((n) => Number(n.recipientId) === instructorA.id), 'instructor recipient');
    // Old/new values recorded per move.
    const transitions = memberNotifs.map((n) => `${parsePayload(n).oldDate} ${parsePayload(n).oldTime}->${parsePayload(n).newDate} ${parsePayload(n).newTime}`).sort();
    assert.deepStrictEqual(transitions, [
      `${dateA} 09:00->${dateB} 09:30`,
      `${dateA} 09:00->${dateB} 09:30`,
      `${dateB} 09:30->${dateA} 09:00`,
    ], 'old/new values for every move');

    // Reminders consistent with the FINAL slot (B): exactly one member reminder
    // delivered with the final date/time, exactly one instructor reminder for
    // slot B, none for slot A, and no duplicate reminder jobs.
    const memberReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' },
    });
    const forReservation = memberReminders.filter((n) => parsePayload(n) && parsePayload(n).reservationId === id);
    assert.strictEqual(forReservation.length, 1, 'exactly one member reminder delivered');
    assert.strictEqual(parsePayload(forReservation[0]).date, dateB, 'member reminder for final date');
    assert.strictEqual(parsePayload(forReservation[0]).time, '09:30', 'member reminder for final time');

    const instructorReminders = await Notification.findAll({
      where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' },
    });
    const forSlotB = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).date === dateB && parsePayload(n).time === '09:30');
    const forSlotA = instructorReminders.filter((n) => parsePayload(n) && parsePayload(n).date === dateA && parsePayload(n).time === '09:00');
    assert.strictEqual(forSlotB.length, 1, 'exactly one instructor reminder for final slot B');
    assert.strictEqual(forSlotA.length, 0, 'no instructor reminder for slot A');

    const memberReminderJobs = await NotificationJob.findAll({ where: { dedupKey: `class_reminder:member:${id}` } });
    assert.strictEqual(memberReminderJobs.length, 1, 'no duplicate member reminder job');
    const instructorReminderJobsB = await NotificationJob.findAll({ where: { dedupKey: `class_reminder:instructor:${dateB}:09:30:${salonA.id}:${instructorA.id}` } });
    assert.strictEqual(instructorReminderJobsB.length, 1, 'no duplicate instructor reminder job for slot B');
    console.log('U9 OK: repeated moves A->B->A->B -> all notified, reminders consistent');
  }

  console.log('All reservation-update-notification cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
