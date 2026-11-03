// Disposable validator (not part of product code): regression coverage for
// studio notification preferences — reservationAlertsEnabled gates reservation
// lifecycle notifications at the source and push, existing categories/defaults
// preserved, settings API round-trip, and studio isolation — against an
// isolated temp SQLite DB. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-prefs-'));
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
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const reservationController = require('../controllers/reservationController');
const notificationWorker = require('../services/notificationWorker');
const notificationService = require('../services/notificationService');
const pushDeliveryService = require('../services/pushDeliveryService');

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
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const equipmentA = await Equipment.create({ name: 'Mat A', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  async function makeMemberWithAccount(name, phone, studioId = studioA.id) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId: instructorA.id, remainingLessons: 50, isActive: true, studioId,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId, memberId: member.id });
    return { member, account };
  }

  async function createSingle(member, date, time) {
    const res = mockRes();
    await reservationController.createReservation(
      reqFor(asAdminA, { memberId: member.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function notifCount(studioId, type) {
    return Notification.count({ where: { studioId, type } });
  }

  // --- P1: defaults -> reservationAlertsEnabled true, all categories on ---
  {
    const settings = await notificationService.getStudioNotificationSettings(studioA.id);
    assert.strictEqual(settings.reservationAlertsEnabled, true, 'reservationAlertsEnabled defaults true');
    assert.strictEqual(settings.classReminderEnabled, true);
    assert.strictEqual(settings.packageAlertsEnabled, true);
    assert.strictEqual(settings.paymentAlertsEnabled, true);
    assert.strictEqual(settings.inactivityAlertsEnabled, true);
    console.log('P1 OK: defaults preserved (all categories on)');
  }

  // --- P2: reservation notifications delivered when enabled ---
  {
    const { member } = await makeMemberWithAccount('P2 Member', '+905477710001');
    await createSingle(member, futureDate(3), '10:00');
    await processAll();
    assert.strictEqual(await notifCount(studioA.id, 'reservation_confirmed'), 2, 'member + instructor confirmation');
    console.log('P2 OK: reservation notifications delivered when enabled');
  }

  // --- P3: reservationAlertsEnabled=false -> no reservation notifications, reminders still fire ---
  {
    await StudioNotificationSettings.create({ studioId: studioA.id, reservationAlertsEnabled: false });
    const { member } = await makeMemberWithAccount('P3 Member', '+905477710002');
    await createSingle(member, futureDate(4), '11:00');
    await processAll();
    assert.strictEqual(await notifCount(studioA.id, 'reservation_confirmed'), 2, 'no NEW confirmation (still 2 from P2)');
    // Class reminders are a separate category -> still delivered.
    const reminders = await Notification.count({ where: { studioId: studioA.id, type: 'class_reminder' } });
    assert.ok(reminders >= 2, 'class reminders unaffected by reservationAlertsEnabled');
    console.log('P3 OK: reservationAlertsEnabled=false suppresses reservation notifications only');
  }

  // --- P4: re-enable -> reservation notifications resume ---
  {
    const s = await StudioNotificationSettings.findOne({ where: { studioId: studioA.id } });
    await s.update({ reservationAlertsEnabled: true });
    const { member } = await makeMemberWithAccount('P4 Member', '+905477710003');
    await createSingle(member, futureDate(5), '12:00');
    await processAll();
    assert.strictEqual(await notifCount(studioA.id, 'reservation_confirmed'), 4, 'confirmations resume after re-enable');
    console.log('P4 OK: re-enable resumes reservation notifications');
  }

  // --- P5: push categoryEnabled covers reservation types ---
  {
    const settingsOff = { reservationAlertsEnabled: false };
    const settingsOn = { reservationAlertsEnabled: true };
    for (const type of ['reservation_confirmed', 'reservation_series_confirmed', 'reservation_updated', 'reservation_cancelled']) {
      assert.strictEqual(pushDeliveryService.categoryEnabled(settingsOff, type), false, `${type} push off when disabled`);
      assert.strictEqual(pushDeliveryService.categoryEnabled(settingsOn, type), true, `${type} push on when enabled`);
    }
    // Other categories unaffected.
    assert.strictEqual(pushDeliveryService.categoryEnabled({}, 'class_reminder'), true);
    assert.strictEqual(pushDeliveryService.categoryEnabled({}, 'package_assigned'), true);
    assert.strictEqual(pushDeliveryService.categoryEnabled({}, 'payment_overdue'), true);
    assert.strictEqual(pushDeliveryService.categoryEnabled({}, 'member_inactive'), true);
    console.log('P5 OK: push category mapping covers reservation types');
  }

  // --- P6: studio isolation ---
  {
    const notifsB = await Notification.findAll({ where: { studioId: studioB.id } });
    assert.strictEqual(notifsB.length, 0, 'studio B has no notifications');
    const settingsB = await notificationService.getStudioNotificationSettings(studioB.id);
    assert.strictEqual(settingsB.reservationAlertsEnabled, true, 'studio B defaults independent');
    console.log('P6 OK: studio isolation preserved');
  }

  console.log('All notification-preferences cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
