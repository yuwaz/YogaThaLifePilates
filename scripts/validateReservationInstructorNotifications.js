// Disposable validator (not part of product code): focused regression coverage
// for instructor reservation notifications — instructor notified on single/series
// creation with member name + salon + date/time, "Rezervasyon İptali" (never
// "class cancelled") cancellation copy identifying the member, recurring
// cancellation dedup by first affected date, chronological ordering of unordered
// caller input, and enqueue idempotency — against an isolated temp SQLite DB.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-instructor-'));
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
const reservationNotificationService = require('../services/reservationNotificationService');
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

async function instructorNotifs(studioId, type) {
  return Notification.findAll({ where: { studioId, type, recipientType: 'instructor' } });
}

async function memberNotifs(studioId, type) {
  return Notification.findAll({ where: { studioId, type, recipientType: 'member' } });
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
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

  // --- R1: single create -> instructor notified with member/salon/date/time ---
  {
    const { member, account } = await makeMemberWithAccount('Ayse Yilmaz', '+905411110001', instructorA.id);
    const date = futureDate(3);
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '10:00' }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));

    await processAll();
    const instructor = (await instructorNotifs(studioA.id, 'reservation_confirmed'))
      .find((n) => parsePayload(n) && parsePayload(n).reservationId === res.body.id);
    assert.ok(instructor, 'instructor confirmation notification exists');
    assert.strictEqual(Number(instructor.recipientId), instructorA.id);
    assert.strictEqual(instructor.title, 'Yeni Rezervasyon');
    assert.ok(instructor.body.includes('Ayse Yilmaz'), 'body names the member');
    assert.ok(instructor.body.includes(date), 'body has date');
    assert.ok(instructor.body.includes('10:00'), 'body has time');
    assert.ok(instructor.body.includes('Salon A'), 'body has salon');
    const p = parsePayload(instructor);
    assert.strictEqual(p.memberId, member.id);
    assert.strictEqual(p.memberName, 'Ayse Yilmaz');
    assert.strictEqual(p.salonId, salonA.id);
    assert.strictEqual(p.salonName, 'Salon A');
    assert.strictEqual(p.date, date);
    assert.strictEqual(p.time, '10:00');

    // Member notification preserved.
    const memberN = (await memberNotifs(studioA.id, 'reservation_confirmed'))
      .find((n) => parsePayload(n) && parsePayload(n).reservationId === res.body.id);
    assert.ok(memberN, 'member confirmation preserved');
    assert.strictEqual(Number(memberN.recipientId), account.id);
    assert.strictEqual(memberN.title, 'Rezervasyon Onayı');
    assert.strictEqual(memberN.body, `Rezervasyonunuz ${date} 10:00 için onaylandı.`);
    console.log('R1 OK: single create -> instructor notified (member/salon/date/time), member preserved');
  }

  // --- R2: series create -> ONE instructor summary with details ---
  {
    const { member, account } = await makeMemberWithAccount('Mehmet Demir', '+905411110002', instructorA.id);
    const date = futureDate(5);
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '11:00', repeatWeekly: true, recurrenceEndDate: futureDate(26) }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.length, 4, '4 occurrences');
    const groupId = res.body[0].recurrenceGroupId;

    await processAll();
    const instructor = (await instructorNotifs(studioA.id, 'reservation_series_confirmed'))
      .filter((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.strictEqual(instructor.length, 1, 'ONE instructor series summary');
    assert.strictEqual(Number(instructor[0].recipientId), instructorA.id);
    assert.strictEqual(instructor[0].title, 'Yeni Rezervasyon Serisi');
    assert.ok(instructor[0].body.includes('Mehmet Demir'), 'body names the member');
    assert.ok(instructor[0].body.includes(date), 'body has first date');
    assert.ok(instructor[0].body.includes('11:00'), 'body has time');
    assert.ok(instructor[0].body.includes('Salon A'), 'body has salon');
    const p = parsePayload(instructor[0]);
    assert.strictEqual(p.memberName, 'Mehmet Demir');
    assert.strictEqual(p.firstDate, date);
    assert.strictEqual(p.time, '11:00');
    assert.strictEqual(p.salonName, 'Salon A');
    assert.strictEqual(p.count, 4);

    // Member series notification preserved.
    const memberN = (await memberNotifs(studioA.id, 'reservation_series_confirmed'))
      .filter((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.strictEqual(memberN.length, 1, 'ONE member series summary');
    assert.strictEqual(Number(memberN[0].recipientId), account.id);
    assert.strictEqual(memberN[0].title, 'Rezervasyon Serisi Onayı');
    assert.strictEqual(memberN[0].body, `Haftalık rezervasyonlarınız ${date} 11:00 tarihinden itibaren her hafta için onaylandı (4 ders).`);
    console.log('R2 OK: series create -> ONE instructor summary, member preserved');
  }

  // --- R3: single cancellation -> "Rezervasyon İptali" identifying the member ---
  {
    const { member, account } = await makeMemberWithAccount('Elif Kaya', '+905411110003', instructorA.id);
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

    // Reminder suppression preserved.
    const memberReminder = await NotificationJob.findOne({ where: { dedupKey: `class_reminder:member:${reservationId}` } });
    assert.strictEqual(memberReminder.processingState, 'done', 'member reminder suppressed');
    assert.strictEqual(memberReminder.lastError, 'cancelled');

    await processAll();
    const instructor = (await instructorNotifs(studioA.id, 'reservation_cancelled'))
      .find((n) => parsePayload(n) && (parsePayload(n).reservationIds || []).includes(reservationId));
    assert.ok(instructor, 'instructor cancellation notification exists');
    assert.strictEqual(Number(instructor.recipientId), instructorA.id);
    assert.strictEqual(instructor.title, 'Rezervasyon İptali', 'never "Ders İptali"/class cancelled');
    assert.ok(!instructor.body.includes('dersiniz'), 'body does not imply the class was cancelled');
    assert.ok(instructor.body.includes('Elif Kaya'), 'body names the member');
    assert.ok(instructor.body.includes(date), 'body has date');
    assert.ok(instructor.body.includes('13:00'), 'body has time');
    assert.ok(instructor.body.includes('Salon A'), 'body has salon');
    const p = parsePayload(instructor);
    assert.strictEqual(p.scope, 'single');
    assert.deepStrictEqual(p.reservationIds, [reservationId]);
    assert.strictEqual(p.memberId, member.id);
    assert.strictEqual(p.memberName, 'Elif Kaya');
    assert.strictEqual(p.salonId, salonA.id);
    assert.strictEqual(p.salonName, 'Salon A');
    assert.strictEqual(p.date, date);
    assert.strictEqual(p.time, '13:00');

    // Member cancellation preserved.
    const memberN = (await memberNotifs(studioA.id, 'reservation_cancelled'))
      .find((n) => parsePayload(n) && (parsePayload(n).reservationIds || []).includes(reservationId));
    assert.ok(memberN, 'member cancellation preserved');
    assert.strictEqual(Number(memberN.recipientId), account.id);
    assert.strictEqual(memberN.title, 'Rezervasyon İptali');
    assert.strictEqual(memberN.body, `${date} 13:00 tarihli rezervasyonunuz iptal edildi.`);
    console.log('R3 OK: single cancellation -> "Rezervasyon İptali" with member + reservation details');
  }

  // --- R4: recurring cancellation dedup -> second partial cancellation still notifies ---
  {
    const { member } = await makeMemberWithAccount('Can Yilmaz', '+905411110004', instructorA.id);
    const d0 = futureDate(14);
    const createRes = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date: d0, time: '14:00', repeatWeekly: true, recurrenceEndDate: futureDate(49) }), createRes);
    assert.strictEqual(createRes.statusCode, 201, JSON.stringify(createRes.body));
    assert.strictEqual(createRes.body.length, 6, '6 occurrences');
    const groupId = createRes.body[0].recurrenceGroupId;
    const dateAt = (i) => futureDate(14 + 7 * i);
    const byDate = (d) => createRes.body.find((r) => r.date === d);

    // First partial cancellation: future from occurrence 3 (deletes d3..d5).
    const del1 = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: byDate(dateAt(3)).id }, query: { deleteScope: 'future' } }), del1);
    assert.strictEqual(del1.statusCode, 204, JSON.stringify(del1.body));
    // Second partial cancellation: future from occurrence 1 (deletes d1..d2).
    const del2 = mockRes();
    await reservationController.deleteReservation(
      reqFor(asAdminA, {}, { params: { id: byDate(dateAt(1)).id }, query: { deleteScope: 'future' } }), del2);
    assert.strictEqual(del2.statusCode, 204, JSON.stringify(del2.body));

    // Distinct dedup keys per first affected date.
    const job1 = await NotificationJob.findOne({ where: { dedupKey: `reservation_cancelled:${groupId}:${dateAt(3)}` } });
    const job2 = await NotificationJob.findOne({ where: { dedupKey: `reservation_cancelled:${groupId}:${dateAt(1)}` } });
    assert.ok(job1, 'first partial cancellation job');
    assert.ok(job2, 'second partial cancellation job (not dropped by dedup)');

    await processAll();
    const instructor = (await instructorNotifs(studioA.id, 'reservation_cancelled'))
      .filter((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.strictEqual(instructor.length, 2, 'BOTH partial cancellations notified the instructor');
    const byFirstDate = new Map(instructor.map((n) => [parsePayload(n).date, parsePayload(n)]));
    assert.strictEqual(byFirstDate.get(dateAt(3)).count, 3, 'first cancellation count 3');
    assert.strictEqual(byFirstDate.get(dateAt(3)).scope, 'series');
    assert.strictEqual(byFirstDate.get(dateAt(1)).count, 2, 'second cancellation count 2');
    for (const n of instructor) {
      assert.strictEqual(n.title, 'Rezervasyon İptali');
      assert.ok(n.body.includes('Can Yilmaz'), 'body names the member');
    }
    console.log('R4 OK: recurring cancellation dedup keyed by first affected date');
  }

  // --- R5: chronological ordering with unordered caller input ---
  {
    const { member } = await makeMemberWithAccount('Zeynep Arslan', '+905411110005', instructorA.id);
    const o0 = futureDate(60);
    const o1 = futureDate(67);
    const o2 = futureDate(74);
    const groupId = 'recurr-order-test';
    const mk = (date) => Reservation.create({
      memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '18:00',
      recurrenceGroupId: groupId, recurrenceType: 'weekly', studioId: studioA.id,
    });
    const r0 = await mk(o0);
    const r1 = await mk(o1);
    const r2 = await mk(o2);

    // Series confirmation with reversed input -> earliest date wins.
    await reservationNotificationService.notifySeriesReservationCreated([r2, r0, r1], { studioId: studioA.id });
    // Cancellation with shuffled input -> earliest date wins.
    await reservationNotificationService.notifyReservationCancelled([r1, r2, r0], { studioId: studioA.id });

    await processAll();
    const series = (await instructorNotifs(studioA.id, 'reservation_series_confirmed'))
      .find((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.ok(series, 'series confirmation exists');
    assert.strictEqual(parsePayload(series).firstDate, o0, 'series firstDate is earliest');
    assert.ok(series.body.includes(o0), 'series body starts from earliest date');

    const cancel = (await instructorNotifs(studioA.id, 'reservation_cancelled'))
      .find((n) => parsePayload(n) && parsePayload(n).recurrenceGroupId === groupId);
    assert.ok(cancel, 'cancellation exists');
    assert.strictEqual(parsePayload(cancel).date, o0, 'cancellation date is earliest');
    assert.ok(cancel.body.includes(o0), 'cancellation body starts from earliest date');
    const cancelJob = await NotificationJob.findOne({ where: { dedupKey: `reservation_cancelled:${groupId}:${o0}` } });
    assert.ok(cancelJob, 'cancellation dedup key uses earliest date');
    console.log('R5 OK: chronological ordering for unordered caller input');
  }

  // --- R6: enqueue idempotency (same dedup key -> no duplicate job/notification) ---
  {
    const { member } = await makeMemberWithAccount('Deniz Ak', '+905411110006', instructorA.id);
    const date = futureDate(80);
    const reservation = await Reservation.create({
      memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '19:00', studioId: studioA.id,
    });
    await reservationNotificationService.notifySingleReservationCreated(reservation, { studioId: studioA.id });
    await reservationNotificationService.notifySingleReservationCreated(reservation, { studioId: studioA.id });
    const confirmJobs = await NotificationJob.findAll({ where: { dedupKey: `reservation_confirmed:${reservation.id}` } });
    assert.strictEqual(confirmJobs.length, 1, 'duplicate confirmation enqueue deduped');

    await reservationNotificationService.notifyReservationCancelled([reservation], { studioId: studioA.id });
    await reservationNotificationService.notifyReservationCancelled([reservation], { studioId: studioA.id });
    const cancelJobs = await NotificationJob.findAll({ where: { dedupKey: `reservation_cancelled:${reservation.id}` } });
    assert.strictEqual(cancelJobs.length, 1, 'duplicate cancellation enqueue deduped');

    await processAll();
    const confirmed = (await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_confirmed' } }))
      .filter((n) => parsePayload(n) && parsePayload(n).reservationId === reservation.id);
    assert.strictEqual(confirmed.filter((n) => n.recipientType === 'member').length, 1, 'one member confirmation');
    assert.strictEqual(confirmed.filter((n) => n.recipientType === 'instructor').length, 1, 'one instructor confirmation');
    const cancelled = (await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_cancelled' } }))
      .filter((n) => parsePayload(n) && (parsePayload(n).reservationIds || []).includes(reservation.id));
    assert.strictEqual(cancelled.filter((n) => n.recipientType === 'member').length, 1, 'one member cancellation');
    assert.strictEqual(cancelled.filter((n) => n.recipientType === 'instructor').length, 1, 'one instructor cancellation');
    console.log('R6 OK: enqueue idempotency preserved');
  }

  // --- R7: no assigned instructor -> member still notified, no instructor row ---
  {
    const { member, account } = await makeMemberWithAccount('No Instructor', '+905411110007', null);
    const date = futureDate(85);
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '20:00' }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));

    await processAll();
    const instructor = (await instructorNotifs(studioA.id, 'reservation_confirmed'))
      .find((n) => parsePayload(n) && parsePayload(n).reservationId === res.body.id);
    assert.strictEqual(instructor, undefined, 'no instructor notification without assigned instructor');
    const memberN = (await memberNotifs(studioA.id, 'reservation_confirmed'))
      .find((n) => parsePayload(n) && parsePayload(n).reservationId === res.body.id);
    assert.ok(memberN, 'member confirmation still delivered');
    assert.strictEqual(Number(memberN.recipientId), account.id);
    console.log('R7 OK: no assigned instructor -> member notified, no instructor row');
  }

  console.log('All reservation-instructor-notification cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
