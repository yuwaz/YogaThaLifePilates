// Disposable validator (not part of product code): end-to-end notification
// integration — business event -> job -> processDueJobs -> inbox row, for both
// event-driven and daily-scheduled pipelines, plus the inbox controller contract.
// Uses disposable SQLite only; no HTTP server, no real timers, no worker flag.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-e2e-'));
const dbPath = path.join(tmpRoot, 'e2e.sqlite');
process.env.DB_PATH = dbPath;
process.env.MEMBER_JWT_SECRET = 'temporary-member-secret-for-e2e';
delete process.env.NOTIFICATIONS_WORKER_ENABLED;

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
  LessonPackage,
  MemberLessonPackage,
  Reservation,
  Attendance,
  Notification,
  NotificationJob,
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const ensureMemberLessonPackageExpiryAndDueDate = require('../ensureMemberLessonPackageExpiryAndDueDate');
const reservationController = require('../controllers/reservationController');
const memberController = require('../controllers/memberController');
const attendanceController = require('../controllers/attendanceController');
const notificationController = require('../controllers/notificationController');
const notificationWorker = require('../services/notificationWorker');
const notificationScheduler = require('../services/notificationScheduler');
const packageNotificationService = require('../services/packageNotificationService');
const { getStudioLocalDate } = require('../services/instructorFeeHistoryService');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
  return res;
}

function staffReq(user, body = {}, extra = {}) {
  return { user, body, query: {}, params: {}, ...extra };
}
function memberReq(accountId, extra = {}) {
  return { memberAccountId: accountId, body: {}, query: {}, params: {}, ...extra };
}

function parsePayload(n) {
  if (!n) return null;
  if (n.payload && typeof n.payload === 'object') return n.payload;
  if (typeof n.payload === 'string') { try { return JSON.parse(n.payload); } catch { return null; } }
  return null;
}

function dateStr(d) { return d.toISOString().slice(0, 10); }
async function studioDaysFromNow(studioId, n) {
  const today = await getStudioLocalDate(studioId);
  return dateStr(new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000));
}

async function processAll() {
  return notificationWorker.processDueJobs({ now: new Date(Date.now() + 365 * 86400000) });
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();
  await ensureMemberLessonPackageExpiryAndDueDate();

  // --- Fixtures: two studios ---
  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const equipmentA = await Equipment.create({ name: 'Mat A', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const lessonPackageA = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  async function makeMemberWithAccount(name, phone, assignedInstructorId, studioId, totalDebt = 0) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId, remainingLessons: 0, totalDebt, isActive: true, studioId,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId, memberId: member.id });
    return { member, account };
  }

  async function createReservation(memberId, date, time, extra = {}) {
    const res = mockRes();
    await reservationController.createReservation(
      staffReq(asAdminA, { memberId, equipmentId: equipmentA.id, salonId: salonA.id, date, time, ...extra }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function addPackage(memberId) {
    const res = mockRes();
    await memberController.addLessonPackage(
      staffReq(asAdminA, { lessonPackageId: lessonPackageA.id }, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function addAttendance(memberId, date) {
    await Reservation.create({ memberId, equipmentId: equipmentA.id, salonId: salonA.id, date, time: '10:00', studioId: studioA.id });
    const res = mockRes();
    await attendanceController.addAttendance(
      staffReq(asAdminA, { memberId, salonId: salonA.id, date, instructorId: instructorA.id }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  // ============================================================
  // PART 1: EVENT-DRIVEN PIPELINE
  // ============================================================

  // --- E1: single reservation confirmation -> inbox ---
  {
    const { member, account } = await makeMemberWithAccount('Member E1', '+905326610001', instructorA.id, studioA.id);
    const date = await studioDaysFromNow(studioA.id, 3);
    await createReservation(member.id, date, '10:00');
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_confirmed' } });
    assert.strictEqual(notifs.length, 1, 'one confirmation');
    assert.strictEqual(Number(notifs[0].recipientId), account.id, 'member recipient');
    assert.strictEqual(notifs[0].recipientType, 'member');
    console.log('E1 OK: single reservation confirmation -> inbox');
  }

  // --- E2: recurring reservation -> ONE summary ---
  {
    const { member, account } = await makeMemberWithAccount('Member E2', '+905326610002', instructorA.id, studioA.id);
    const date = await studioDaysFromNow(studioA.id, 5);
    await createReservation(member.id, date, '11:00', { repeatWeekly: true, recurrenceEndDate: await studioDaysFromNow(studioA.id, 26) });
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_series_confirmed' } });
    assert.strictEqual(notifs.length, 1, 'ONE series summary');
    assert.strictEqual(Number(notifs[0].recipientId), account.id);
    assert.strictEqual(parsePayload(notifs[0]).recurrenceType, 'weekly');
    console.log('E2 OK: recurring reservation -> ONE summary');
  }

  // --- E3: member + instructor class reminders ---
  {
    const { member, account } = await makeMemberWithAccount('Member E3', '+905326610003', instructorA.id, studioA.id);
    const date = await studioDaysFromNow(studioA.id, 7);
    await createReservation(member.id, date, '12:00');
    await processAll();
    const memberReminder = await Notification.findOne({ where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'member' } });
    const instructorReminder = await Notification.findOne({ where: { studioId: studioA.id, type: 'class_reminder', recipientType: 'instructor' } });
    assert.ok(memberReminder, 'member reminder delivered');
    assert.ok(instructorReminder, 'instructor reminder delivered');
    assert.strictEqual(Number(instructorReminder.recipientId), instructorA.id, 'assigned instructor');
    console.log('E3 OK: member + instructor class reminders');
  }

  // --- E4: reservation cancellation -> member + instructor ---
  {
    const { member, account } = await makeMemberWithAccount('Member E4', '+905326610004', instructorA.id, studioA.id);
    const date = await studioDaysFromNow(studioA.id, 9);
    const reservation = await createReservation(member.id, date, '13:00');
    const delRes = mockRes();
    await reservationController.deleteReservation(staffReq(asAdminA, {}, { params: { id: reservation.id }, query: {} }), delRes);
    assert.strictEqual(delRes.statusCode, 204);
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'reservation_cancelled' } });
    const memberCancel = notifs.find((n) => n.recipientType === 'member');
    const instructorCancel = notifs.find((n) => n.recipientType === 'instructor');
    assert.ok(memberCancel && instructorCancel, 'member + instructor cancellation');
    console.log('E4 OK: reservation cancellation -> member + instructor');
  }

  // --- E5: package assignment -> member ---
  {
    const { member, account } = await makeMemberWithAccount('Member E5', '+905326610005', instructorA.id, studioA.id);
    await addPackage(member.id);
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'package_assigned' } });
    assert.strictEqual(notifs.length, 1, 'one package_assigned');
    assert.strictEqual(Number(notifs[0].recipientId), account.id);
    console.log('E5 OK: package assignment -> member');
  }

  // --- E6: remaining lessons thresholds (2 and 0) ---
  {
    const { member, account } = await makeMemberWithAccount('Member E6', '+905326610006', instructorA.id, studioA.id);
    await addPackage(member.id); // 10 lessons
    let fresh = await Member.findByPk(member.id);
    fresh.remainingLessons = 3;
    await fresh.save();
    await addAttendance(member.id, await studioDaysFromNow(studioA.id, 1)); // -> 2
    fresh = await Member.findByPk(member.id);
    await addAttendance(member.id, await studioDaysFromNow(studioA.id, 2)); // -> 1
    fresh = await Member.findByPk(member.id);
    await addAttendance(member.id, await studioDaysFromNow(studioA.id, 3)); // -> 0
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'package_low_lessons' } });
    const forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).memberId === member.id);
    const thresholds = new Set(forMember.map((n) => parsePayload(n).remainingLessons));
    assert.ok(thresholds.has(2) && thresholds.has(0), 'both 2 and 0 thresholds fired');
    const recipientTypes = new Set(forMember.map((n) => n.recipientType));
    assert.ok(recipientTypes.has('member') && recipientTypes.has('instructor') && recipientTypes.has('admin'), 'member+instructor+admin');
    console.log('E6 OK: remaining lessons thresholds 2 and 0');
  }

  // ============================================================
  // PART 2: DAILY SCHEDULED PIPELINE
  // ============================================================

  // Activate payment reminders for studio A.
  const activationDate = await studioDaysFromNow(studioA.id, -30);
  await StudioNotificationSettings.create({ studioId: studioA.id, paymentRemindersActivatedAt: activationDate });

  // --- D1: package expiry (daily check -> job -> worker -> inbox) ---
  {
    const { member, account } = await makeMemberWithAccount('Member D1', '+905326610007', instructorA.id, studioA.id);
    const expiryDate = await studioDaysFromNow(studioA.id, 7);
    await MemberLessonPackage.create({
      memberId: member.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(),
      originalPrice: 1000, finalPrice: 1000, expiresAt: expiryDate, studioId: studioA.id,
    });
    // Daily check.
    const ran = await notificationScheduler.runDailyChecksForStudio(studioA, { now: new Date() });
    assert.ok(ran.ran >= 1, 'daily check ran');
    const expiryJob = await NotificationJob.findOne({ where: { studioId: studioA.id, type: 'package_expiring' } });
    assert.ok(expiryJob, 'expiry job enqueued by daily check');
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'package_expiring' } });
    const forMember = notifs.filter((n) => {
      const p = parsePayload(n);
      return p && p.memberLessonPackageId && n.recipientType === 'member';
    });
    assert.ok(forMember.length >= 1, 'expiry notification in inbox');
    console.log('D1 OK: package expiry daily pipeline');
  }

  // --- D2: payment reminders day 3 and day 7 ---
  {
    const { member, account } = await makeMemberWithAccount('Member D2', '+905326610008', instructorA.id, studioA.id, 500);
    // Day 3.
    await MemberLessonPackage.create({
      memberId: member.id, lessonPackageId: lessonPackageA.id,
      assignedAt: new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T12:00:00Z')),
      originalPrice: 1000, finalPrice: 1000, studioId: studioA.id,
    });
    let result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 1, 'day-3 admin reminder');
    await processAll();
    let notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'payment_overdue' } });
    let forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).memberId === member.id);
    assert.ok(forMember.every((n) => n.recipientType === 'admin'), 'day 3: admin only');

    // Day 7.
    const assignment = await MemberLessonPackage.findOne({ where: { memberId: member.id } });
    await assignment.update({ assignedAt: new Date(Date.parse(await studioDaysFromNow(studioA.id, -7) + 'T12:00:00Z')) });
    result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 2, 'day-7 admin + member');
    await processAll();
    notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'payment_overdue' } });
    forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).memberId === member.id && parsePayload(n).daysSince === 7);
    const types = new Set(forMember.map((n) => n.recipientType));
    assert.ok(types.has('admin') && types.has('member'), 'day 7: admin + member');
    console.log('D2 OK: payment reminders day 3 and day 7');
  }

  // --- D3: inactivity threshold ---
  {
    const { member } = await makeMemberWithAccount('Member D3', '+905326610009', instructorA.id, studioA.id);
    await Attendance.create({
      memberId: member.id, salonId: salonA.id, date: new Date(Date.now() - 14 * 86400000), studioId: studioA.id,
    });
    const result = await packageNotificationService.checkMemberInactivity({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 1, 'inactivity reminder enqueued');
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'member_inactive' } });
    const forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).memberId === member.id);
    const types = new Set(forMember.map((n) => n.recipientType));
    assert.ok(types.has('instructor') && types.has('admin'), 'instructor + admin');
    assert.ok(!types.has('member'), 'member not notified');
    console.log('D3 OK: inactivity threshold daily pipeline');
  }

  // --- D4: daily check deduplication (restart-safe) ---
  {
    const ran1 = await notificationScheduler.runDailyChecksForStudio(studioA, { now: new Date() });
    const ran2 = await notificationScheduler.runDailyChecksForStudio(studioA, { now: new Date() });
    assert.strictEqual(ran2.ran, 0, 'second daily run: no duplicate checks');
    console.log('D4 OK: daily check deduplication');
  }

  // --- D5: disabled category suppression ---
  {
    await StudioNotificationSettings.update({ packageAlertsEnabled: false }, { where: { studioId: studioA.id } });
    const { member } = await makeMemberWithAccount('Member D5', '+905326610010', instructorA.id, studioA.id);
    const expiryDate = await studioDaysFromNow(studioA.id, 7);
    await MemberLessonPackage.create({
      memberId: member.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(),
      originalPrice: 1000, finalPrice: 1000, expiresAt: expiryDate, studioId: studioA.id,
    });
    const result = await packageNotificationService.checkPackageExpiry({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 0, 'disabled category suppressed');
    // Re-enable for other tests.
    await StudioNotificationSettings.update({ packageAlertsEnabled: true }, { where: { studioId: studioA.id } });
    console.log('D5 OK: disabled category suppression');
  }

  // ============================================================
  // PART 3: INBOX CONTRACT
  // ============================================================

  // --- I1: member inbox retrieval (global visibility) ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: '+905326610001' } });
    const res = mockRes();
    await notificationController.memberInbox(memberReq(account.id), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.notifications.length >= 1, 'member inbox has notifications');
    assert.ok(res.body.notifications.every((n) => n.id), 'notifications have ids');
    console.log('I1 OK: member inbox retrieval');
  }

  // --- I2: staff inbox retrieval + no cross-studio leakage ---
  {
    const resA = mockRes();
    await notificationController.staffInbox(staffReq(asAdminA), resA);
    assert.strictEqual(resA.statusCode, 200);
    assert.ok(resA.body.notifications.length >= 1, 'admin A has notifications');
    const resB = mockRes();
    await notificationController.staffInbox(staffReq({ id: adminB.id, role: 'admin', studioId: studioB.id }), resB);
    assert.strictEqual(resB.statusCode, 200);
    assert.strictEqual(resB.body.notifications.length, 0, 'admin B sees none from studio A');
    console.log('I2 OK: staff inbox + no cross-studio leakage');
  }

  // --- I3: read/unread operations ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: '+905326610001' } });
    let res = mockRes();
    await notificationController.memberUnreadCount(memberReq(account.id), res);
    const before = res.body.unreadCount;
    assert.ok(before >= 1, 'has unread');
    const inbox = mockRes();
    await notificationController.memberInbox(memberReq(account.id), inbox);
    const firstId = inbox.body.notifications[0].id;
    res = mockRes();
    await notificationController.memberMarkRead(memberReq(account.id, { params: { id: firstId } }), res);
    assert.strictEqual(res.statusCode, 200);
    res = mockRes();
    await notificationController.memberUnreadCount(memberReq(account.id), res);
    assert.strictEqual(res.body.unreadCount, before - 1, 'unread decremented');
    console.log('I3 OK: read/unread operations');
  }

  // --- I4: no duplicate inbox delivery ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: '+905326610001' } });
    const before = await Notification.count({ where: { studioId: studioA.id, recipientType: 'member', recipientId: account.id } });
    // Reprocess all jobs (should not duplicate).
    await processAll();
    const after = await Notification.count({ where: { studioId: studioA.id, recipientType: 'member', recipientId: account.id } });
    assert.strictEqual(after, before, 'no duplicate inbox delivery on reprocess');
    console.log('I4 OK: no duplicate inbox delivery');
  }

  console.log('All notification-e2e cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
