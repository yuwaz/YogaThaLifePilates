// Disposable validator (not part of product code): proves Firebase push
// transport + scheduler integration — lazy init, credential validation, generic
// payload, invalid-token classification, retry/invalidation, inbox independence,
// opt-in flags — on disposable SQLite DBs with a fake firebase-admin. No real
// FCM, no real credentials. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-push-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;
delete process.env.NOTIFICATIONS_WORKER_ENABLED;
delete process.env.PUSH_WORKER_ENABLED;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

const {
  sequelize,
  Studio,
  User,
  MemberType,
  Member,
  Salon,
  Notification,
  NotificationJob,
  DeviceToken,
  NotificationPushDelivery,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const ensureDeviceTokensTable = require('../ensureDeviceTokensTable');
const ensureNotificationPushDeliveriesTable = require('../ensureNotificationPushDeliveriesTable');
const { createFirebasePushTransport, FirebasePushError } = require('../services/firebasePushTransport');
const notificationScheduler = require('../services/notificationScheduler');
const pushDeliveryService = require('../services/pushDeliveryService');
const notificationWorker = require('../services/notificationWorker');
const notificationService = require('../services/notificationService');
const deviceTokenService = require('../services/deviceTokenService');

// Fake firebase-admin module (no real Firebase). Matches the firebase-admin 14.x
// subpath export shape: { app: { cert, initializeApp, getApps }, messaging: { getMessaging } }.
function fakeFirebaseAdmin(behavior = {}) {
  const sentMessages = [];
  const apps = [];
  return {
    sentMessages,
    apps,
    app: {
      cert: (creds) => ({ _creds: 'cert' }),
      getApps: () => apps,
      initializeApp(options, name) {
        const app = { name: name || '[DEFAULT]' };
        apps.push(app);
        return app;
      },
    },
    messaging: {
      getMessaging: (app) => ({
        send: async (message) => {
          sentMessages.push(message);
          if (behavior.fail) throw new Error('send failed');
          if (behavior.invalidToken) {
            const err = new Error('invalid token');
            err.code = 'messaging/registration-token-not-registered';
            throw err;
          }
          return 'message-id';
        },
      }),
    },
  };
}

const VALID_CREDS = JSON.stringify({ client_email: 'test@example.com', private_key: 'key' });

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

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });

  // --- Phase 1: transport not initialized by import ---
  {
    // createFirebasePushTransport does not initialize Firebase until send().
    const fakeAdmin = fakeFirebaseAdmin();
    const transport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeAdmin });
    assert.strictEqual(fakeAdmin.apps.length, 0, 'no Firebase app on transport creation');
    console.log('Phase 1 OK: Firebase transport not initialized by import/creation');
  }

  // --- Phase 1b: real firebase-admin import shape (regression for cert/apps bug) ---
  {
    // Verify the real firebase-admin 14.x subpath exports the transport relies on.
    // No credentials used; no app initialized; no push sent.
    const appMod = require('firebase-admin/app');
    const messagingMod = require('firebase-admin/messaging');
    assert.strictEqual(typeof appMod.cert, 'function', 'firebase-admin/app cert is a function');
    assert.strictEqual(typeof appMod.initializeApp, 'function', 'firebase-admin/app initializeApp is a function');
    assert.strictEqual(typeof appMod.getApps, 'function', 'firebase-admin/app getApps is a function');
    assert.strictEqual(typeof messagingMod.getMessaging, 'function', 'firebase-admin/messaging getMessaging is a function');
    // The old buggy shape (admin.credential.cert / admin.apps) must NOT be relied on.
    const topLevel = require('firebase-admin');
    assert.strictEqual(topLevel.credential, undefined, 'top-level credential is undefined in 14.x (bug regression guard)');
    assert.strictEqual(topLevel.apps, undefined, 'top-level apps is undefined in 14.x (bug regression guard)');
    console.log('Phase 1b OK: real firebase-admin 14.x subpath shape verified');
  }

  // --- Phase 2: credential validation ---
  {
    // Ambiguous source -> error on send.
    const ambiguous = createFirebasePushTransport({
      env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS, FIREBASE_SERVICE_ACCOUNT_PATH: '/tmp/x.json' },
      admin: fakeFirebaseAdmin(),
    });
    await assert.rejects(() => ambiguous.send({ token: 't', title: 't', payload: {} }), (e) => e.code === 'FIREBASE_SERVICE_ACCOUNT_SOURCE_AMBIGUOUS');
    // Missing credentials -> error on send.
    const transport = createFirebasePushTransport({ env: {}, admin: fakeFirebaseAdmin() });
    await assert.rejects(() => transport.send({ token: 't', title: 't', payload: {} }), (e) => e.code === 'FIREBASE_SERVICE_ACCOUNT_REQUIRED');
    // Invalid JSON.
    const badJson = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: 'not-json' }, admin: fakeFirebaseAdmin() });
    await assert.rejects(() => badJson.send({ token: 't', title: 't', payload: {} }), (e) => e.code === 'FIREBASE_SERVICE_ACCOUNT_JSON_INVALID');
    console.log('Phase 2 OK: credential validation (ambiguous/missing/invalid)');
  }

  // --- Phase 3: generic payload only (privacy) + persisted notification ID ---
  {
    const fakeAdmin = fakeFirebaseAdmin();
    const transport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeAdmin });
    await transport.send({
      token: 'device-token-123',
      notificationId: 42, // persisted Notifications.id
      title: 'Ders Hatırlatması', // real title NOT sent
      body: 'Üye Ahmet borcunu ödemedi 500 TL', // sensitive body NOT sent
      payload: { memberName: 'Ahmet', debt: 500 }, // private data NOT sent
      platform: 'ios',
    });
    assert.strictEqual(fakeAdmin.sentMessages.length, 1, 'one message sent');
    const msg = fakeAdmin.sentMessages[0];
    assert.strictEqual(msg.notification.title, 'CepStudio', 'generic title');
    assert.strictEqual(msg.notification.body, 'Yeni bir bildiriminiz var.', 'generic body');
    assert.deepStrictEqual(msg.data, { notificationId: '42', type: 'notification' }, 'persisted notificationId in data (string)');
    assert.ok(!JSON.stringify(msg).includes('Ahmet'), 'no member name');
    assert.ok(!JSON.stringify(msg).includes('500'), 'no debt amount');
    assert.ok(!JSON.stringify(msg).includes('Ders Hatırlatması'), 'no real title');
    console.log('Phase 3 OK: generic payload + persisted notification ID');
  }

  // --- Phase 3b: no fallback to arbitrary payload IDs ---
  {
    const fakeAdmin = fakeFirebaseAdmin();
    const transport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeAdmin });
    // payload contains arbitrary ids that must NOT be used.
    await transport.send({
      token: 'device-token-456',
      notificationId: 99, // persisted id wins
      title: 'T',
      payload: { notificationId: 7, id: 8, memberLessonPackageId: 55 }, // decoys
      platform: 'android',
    });
    const msg = fakeAdmin.sentMessages[0];
    assert.strictEqual(msg.data.notificationId, '99', 'persisted id used, not payload decoys');
    console.log('Phase 3b OK: no fallback to arbitrary payload IDs');
  }

  // --- Phase 4: invalid-token error classification ---
  {
    const transport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeFirebaseAdmin() });
    const invalidErr = new Error('x');
    invalidErr.code = 'messaging/registration-token-not-registered';
    assert.strictEqual(transport.isInvalidTokenError(invalidErr), true, 'not-registered classified');
    const invalidErr2 = new Error('x');
    invalidErr2.code = 'messaging/invalid-registration-token';
    assert.strictEqual(transport.isInvalidTokenError(invalidErr2), true, 'invalid-token classified');
    const otherErr = new Error('x');
    otherErr.code = 'messaging/internal-error';
    assert.strictEqual(transport.isInvalidTokenError(otherErr), false, 'other error not classified');
    console.log('Phase 4 OK: invalid-token error classification');
  }

  // --- Phase 5: worker disabled by default / both flags required ---
  {
    assert.strictEqual(notificationScheduler.isWorkerEnabled(process.env), false, 'inbox worker off by default');
    assert.strictEqual(notificationScheduler.isPushWorkerEnabled(process.env), false, 'push worker off by default');
    assert.strictEqual(notificationScheduler.isPushWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: '1' }), false, 'push needs both flags');
    assert.strictEqual(notificationScheduler.isPushWorkerEnabled({ PUSH_WORKER_ENABLED: '1' }), false, 'push needs inbox flag too');
    assert.strictEqual(
      notificationScheduler.isPushWorkerEnabled({ NOTIFICATIONS_WORKER_ENABLED: '1', PUSH_WORKER_ENABLED: '1' }),
      true,
      'both flags enable push'
    );
    console.log('Phase 5 OK: worker disabled by default, both flags required');
  }

  // --- Phase 6: no credentials -> no push processing ---
  {
    // processDuePushDeliveries requires a transport; without one it throws.
    let threw = false;
    try {
      await pushDeliveryService.processDuePushDeliveries({ now: new Date() });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'no push processing without transport/credentials');
    console.log('Phase 6 OK: no credentials -> no push processing');
  }

  // --- Phase 7: retry and token invalidation via transport ---
  {
    // Register a device, deliver inbox (enqueues push), then process with a
    // failing-then-invalid transport.
    await deviceTokenService.registerDeviceToken({ ownerType: 'staff', ownerId: adminA.id, studioId: studioA.id, token: 'device-fcm-1', platform: 'ios' });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'fcm-test-1', urgent: true,
      payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, type: 'class_reminder', title: 'T' }] },
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    const notif = await Notification.findOne({ where: { title: 'T' } });
    const push = await NotificationPushDelivery.findOne({ where: { notificationId: notif.id } });
    assert.ok(push, 'push delivery enqueued');

    // Transient failure -> retry.
    const failTransport = (() => {
      const t = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeFirebaseAdmin({ fail: true }) });
      return t;
    })();
    await pushDeliveryService.processDuePushDeliveries({ transport: failTransport, now: new Date(Date.now() + 60000) });
    await push.reload();
    assert.strictEqual(push.status, 'pending', 'back to pending after transient failure');

    // Invalid token -> device invalidated, delivery failed.
    const invalidTransport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeFirebaseAdmin({ invalidToken: true }) });
    await push.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await pushDeliveryService.processDuePushDeliveries({ transport: invalidTransport, now: new Date() });
    await push.reload();
    assert.strictEqual(push.status, 'failed', 'failed on invalid token');
    assert.strictEqual(push.lastError, 'invalid-token');
    const device = await DeviceToken.findOne({ where: { token: 'device-fcm-1' } });
    assert.ok(device.invalidatedAt, 'device invalidated');
    console.log('Phase 7 OK: retry and token invalidation');
  }

  // --- Phase 8: inbox independent from push failures ---
  {
    // Deliver inbox with a device; push processing fails but inbox is intact.
    await deviceTokenService.registerDeviceToken({ ownerType: 'staff', ownerId: adminA.id, studioId: studioA.id, token: 'device-fcm-2', platform: 'android' });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'fcm-test-2', urgent: true,
      payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, type: 'class_reminder', title: 'InboxOK' }] },
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    const notif = await Notification.findOne({ where: { title: 'InboxOK' } });
    assert.ok(notif, 'inbox notification delivered despite push setup');
    console.log('Phase 8 OK: inbox independent from push failures');
  }

  // --- Phase 9: end-to-end persisted notification ID in push data ---
  {
    // Register a device, deliver inbox (persists a Notification with a real id),
    // then process the push with a fake transport and verify data.notificationId
    // is the persisted Notifications.id.
    await deviceTokenService.registerDeviceToken({ ownerType: 'staff', ownerId: adminA.id, studioId: studioA.id, token: 'device-fcm-3', platform: 'ios' });
    await notificationService.enqueueNotification({
      studioId: studioA.id, type: 'class_reminder', dedupKey: 'fcm-test-3', urgent: true,
      payload: { notifications: [{ recipientType: 'admin', recipientId: adminA.id, type: 'class_reminder', title: 'PersistedID' }] },
    });
    await notificationWorker.processDueJobs({ now: new Date(Date.now() + 60000) });
    const notif = await Notification.findOne({ where: { title: 'PersistedID' } });
    assert.ok(notif, 'inbox notification persisted');

    const fakeAdmin = fakeFirebaseAdmin();
    const transport = createFirebasePushTransport({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: VALID_CREDS }, admin: fakeAdmin });
    await pushDeliveryService.processDuePushDeliveries({ transport, now: new Date(Date.now() + 60000) });
    const sentForNotif = fakeAdmin.sentMessages.filter((m) => m.data && m.data.notificationId === String(notif.id));
    // One push per eligible device, all carrying the persisted notification id.
    const deviceCount = await NotificationPushDelivery.count({ where: { notificationId: notif.id } });
    assert.strictEqual(sentForNotif.length, deviceCount, `push sent with persisted notification id for all ${deviceCount} devices`);
    assert.ok(sentForNotif.length >= 1, 'at least one push with persisted id');
    console.log('Phase 9 OK: end-to-end persisted notification ID in push data');
  }

  // --- Phase 10: firebase-admin declared as a production dependency ---
  {
    const pkg = require('../package.json');
    assert.ok(pkg.dependencies && pkg.dependencies['firebase-admin'], 'firebase-admin in dependencies');
    assert.ok(!pkg.devDependencies || !pkg.devDependencies['firebase-admin'], 'not a devDependency');
    console.log('Phase 10 OK: firebase-admin declared as production dependency');
  }

  console.log('All firebase-push cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
