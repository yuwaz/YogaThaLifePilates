// Disposable validator (not part of product code): proves push delivery queue
// foundation — inbox/push independence, per-device dedup, multi-device,
// cross-studio isolation, token takeover safety, invalidated/category suppression,
// retry/crash recovery, concurrent worker safety, no-push-by-default — on
// isolated temp SQLite DBs with a fake transport. No real FCM. Does not touch
// the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'push-delivery-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  MemberAccount,
  MemberAccountMembership,
  MemberType,
  Member,
  Salon,
  Notification,
  NotificationJob,
  DeviceToken,
  NotificationPushDelivery,
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const ensureDeviceTokensTable = require('../ensureDeviceTokensTable');
const ensureNotificationPushDeliveriesTable = require('../ensureNotificationPushDeliveriesTable');
const notificationWorker = require('../services/notificationWorker');
const notificationService = require('../services/notificationService');
const pushDeliveryService = require('../services/pushDeliveryService');
const deviceTokenService = require('../services/deviceTokenService');

// Fake push transport (no real FCM).
function fakeTransport(behavior = {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push({ title: message.title, platform: message.platform });
      if (behavior.fail) throw new Error('send failed');
      if (behavior.invalidToken) {
        const err = new Error('invalid token');
        err.code = 'messaging/registration-token-not-registered';
        throw err;
      }
    },
    isInvalidTokenError(error) {
      return error && error.code === 'messaging/registration-token-not-registered';
    },
  };
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationPushDeliveries');
  await sequelize.query('DROP TABLE IF EXISTS DeviceTokens');
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();
  await ensureDeviceTokensTable();
  await ensureNotificationPushDeliveriesTable();
  await ensureNotificationPushDeliveriesTable(); // idempotent

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const memberTypeA = await MemberType.create({ name: 'G', color: '#AABBCC', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'S1', type: 'Yoga', studioId: studioA.id });

  async function makeMemberAccount(phone, studioId) {
    const member = await Member.create({
      name: 'M', phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons: 0, isActive: true, studioId,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId, memberId: member.id });
    return account;
  }
  const accountA = await makeMemberAccount('+905329910001', studioA.id);

  async function registerStaff(user, studioId, token, platform = 'ios') {
    return deviceTokenService.registerDeviceToken({ ownerType: 'staff', ownerId: user.id, studioId, token, platform });
  }
  async function registerMember(account, token, platform = 'ios') {
    return deviceTokenService.registerDeviceToken({ ownerType: 'member', ownerId: account.id, studioId: null, token, platform });
  }

  // Helper: persist an inbox notification via the worker (triggers push enqueue).
  async function deliverInbox(studioId, recipientType, recipientId, type = 'class_reminder', title = 'T') {
    await notificationService.enqueueNotification({
      studioId, type, dedupKey: `inbox:${type}:${recipientType}:${recipientId}:${Date.now()}:${Math.random()}`, urgent: true,
      payload: { notifications: [{ recipientType, recipientId, type, title }] },
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    return Notification.findOne({ where: { studioId, recipientType, recipientId, title }, order: [['id', 'DESC']] });
  }

  // --- Phase 1: inbox delivery independent from push failure ---
  {
    // Register a device for adminA, then deliver inbox. Push enqueue happens but
    // no push processing (no transport) -> inbox still delivered.
    await registerStaff(adminA, studioA.id, 'device-admin-a-1');
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'InboxOK');
    assert.ok(notif, 'inbox notification delivered');
    // Push delivery enqueued but not sent (no transport invoked).
    const pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    assert.strictEqual(pushes.length, 1, 'one push delivery enqueued');
    assert.strictEqual(pushes[0].status, 'pending', 'push pending (not sent)');
    console.log('Phase 1 OK: inbox delivery independent from push');
  }

  // --- Phase 2: per-device deduplication ---
  {
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'Dedup');
    // Re-enqueue push for the same notification+device -> no duplicate.
    const first = await pushDeliveryService.enqueuePushDeliveries(notif);
    const second = await pushDeliveryService.enqueuePushDeliveries(notif);
    const pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    assert.strictEqual(pushes.length, 1, 'no duplicate push delivery per device');
    console.log('Phase 2 OK: per-device deduplication');
  }

  // --- Phase 3: multiple devices ---
  {
    await registerStaff(adminA, studioA.id, 'device-admin-a-2', 'android');
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'MultiDevice');
    const pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    assert.strictEqual(pushes.length, 2, 'push enqueued for both devices');
    console.log('Phase 3 OK: multiple devices');
  }

  // --- Phase 4: cross-studio isolation ---
  {
    // adminB (studio B) has a device; a studio A notification must not push to it.
    await registerStaff(adminB, studioB.id, 'device-admin-b-1');
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'CrossStudio');
    const pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    const deviceIds = pushes.map((p) => Number(p.deviceTokenId));
    const adminBDevice = await DeviceToken.findOne({ where: { token: 'device-admin-b-1' } });
    assert.ok(!deviceIds.includes(Number(adminBDevice.id)), 'studio B device not included');
    console.log('Phase 4 OK: cross-studio isolation');
  }

  // --- Phase 5: token takeover safety ---
  {
    // Member A registers a device, then staff adminA takes it over.
    await registerMember(accountA, 'device-takeover-1');
    const notif = await deliverInbox(studioA.id, 'member', accountA.id, 'class_reminder', 'Takeover');
    // Push enqueued for member accountA's device.
    let pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    assert.strictEqual(pushes.length, 1, 'push enqueued for member device');
    // Takeover: staff adminA registers the same token.
    await registerStaff(adminA, studioA.id, 'device-takeover-1');
    // Process the pending push -> ownership changed -> failed (not sent).
    const transport = fakeTransport();
    const sentBefore = transport.sent.length;
    await pushDeliveryService.processDuePushDeliveries({ transport, now: new Date(Date.now() + 60000) });
    await pushes[0].reload();
    assert.strictEqual(pushes[0].status, 'failed', 'push failed after takeover');
    assert.strictEqual(pushes[0].lastError, 'token-ownership-changed');
    // The takeover push specifically was not sent (other pending pushes may send).
    const takeoverSent = transport.sent.slice(sentBefore).filter((m) => m.title === 'Takeover');
    assert.strictEqual(takeoverSent.length, 0, 'no push sent to previous account');
    console.log('Phase 5 OK: token takeover safety');
  }

  // --- Phase 6: invalidated token suppression ---
  {
    await registerStaff(adminA, studioA.id, 'device-inv-1');
    const device = await DeviceToken.findOne({ where: { token: 'device-inv-1' } });
    device.invalidatedAt = new Date();
    await device.save();
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'Invalidated');
    const pushes = await NotificationPushDelivery.findAll({
      where: { notificationId: notif.id },
      include: [{ model: DeviceToken, where: { token: 'device-inv-1' } }],
    });
    assert.strictEqual(pushes.length, 0, 'no push enqueued for invalidated device');
    console.log('Phase 6 OK: invalidated token suppression');
  }

  // --- Phase 7: disabled category suppression ---
  {
    await StudioNotificationSettings.create({ studioId: studioA.id, classReminderEnabled: false });
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'DisabledCat');
    const pushes = await NotificationPushDelivery.findAll({ where: { notificationId: notif.id } });
    assert.strictEqual(pushes.length, 0, 'no push enqueued for disabled category');
    await StudioNotificationSettings.update({ classReminderEnabled: true }, { where: { studioId: studioA.id } });
    console.log('Phase 7 OK: disabled category suppression');
  }

  // --- Phase 8: retry and crash recovery ---
  {
    await registerStaff(adminA, studioA.id, 'device-retry-1');
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'Retry');
    const push = await NotificationPushDelivery.findOne({ where: { notificationId: notif.id } });
    // Fail once -> pending with backoff.
    const failTransport = fakeTransport({ fail: true });
    await pushDeliveryService.processDuePushDeliveries({ transport: failTransport, now: new Date(Date.now() + 60000) });
    await push.reload();
    assert.strictEqual(push.status, 'pending', 'back to pending after failure');
    assert.ok(push.nextAttemptAt, 'backoff scheduled');
    // Crash recovery: stuck in processing.
    await sequelize.query(
      "UPDATE NotificationPushDeliveries SET status='processing', updatedAt=? WHERE id=?",
      { replacements: [new Date(Date.now() - 20 * 60 * 1000).toISOString(), push.id] }
    );
    const recovered = await pushDeliveryService.recoverStaleDeliveries(new Date());
    assert.ok(recovered >= 1, 'stale processing recovered');
    await push.reload();
    assert.strictEqual(push.status, 'pending', 'recovered to pending');
    // Succeed on retry.
    const okTransport = fakeTransport();
    await push.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await pushDeliveryService.processDuePushDeliveries({ transport: okTransport, now: new Date() });
    await push.reload();
    assert.strictEqual(push.status, 'sent', 'sent on retry');
    assert.ok(push.sentAt, 'sentAt set');
    console.log('Phase 8 OK: retry and crash recovery');
  }

  // --- Phase 9: concurrent worker safety ---
  {
    await registerStaff(adminA, studioA.id, 'device-conc-1');
    const notif = await deliverInbox(studioA.id, 'admin', adminA.id, 'class_reminder', 'Concurrent');
    const transport = fakeTransport();
    const now = new Date(Date.now() + 60000);
    const [c1, c2] = await Promise.all([
      pushDeliveryService.claimNextDueDelivery(now),
      pushDeliveryService.claimNextDueDelivery(now),
    ]);
    const claimedCount = [c1, c2].filter(Boolean).length;
    // There may be multiple due deliveries (from earlier phases); just verify no
    // two claims return the SAME delivery id.
    if (c1 && c2) {
      assert.notStrictEqual(Number(c1.id), Number(c2.id), 'no two claims for the same delivery');
    }
    console.log('Phase 9 OK: concurrent worker safety');
  }

  // --- Phase 10: no push execution by default (no transport) ---
  {
    // processDuePushDeliveries requires a transport; without one it throws.
    let threw = false;
    try {
      await pushDeliveryService.processDuePushDeliveries({ now: new Date() });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'no push processing without a transport');
    console.log('Phase 10 OK: no push execution by default');
  }

  console.log('All push-delivery cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
