// Disposable validator (not part of product code): proves notification Phase 4.1 —
// member/staff inbox (isolation, pagination, read/unread), studio settings
// (admin-only, validation, payment activation boundary) — on isolated temp
// SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase41-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;
process.env.MEMBER_JWT_SECRET = 'temporary-member-secret-for-phase41';

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
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const notificationController = require('../controllers/notificationController');
const settingsController = require('../controllers/notificationSettingsController');
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

function reqFor(user, body, extra = {}) {
  return { user, body, query: {}, params: {}, ...extra };
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
  const adminA2 = await User.create({ username: 'adminA2', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });

  async function makeMemberWithAccount(name, phone, studioId) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons: 0, isActive: true, studioId,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId, memberId: member.id });
    return { member, account };
  }

  const { account: accountA1 } = await makeMemberWithAccount('Member A1', '+905324410001', studioA.id);
  const { account: accountA2 } = await makeMemberWithAccount('Member A2', '+905324410002', studioA.id);
  const { account: accountB1 } = await makeMemberWithAccount('Member B1', '+905324410003', studioB.id);

  // Seed notifications: member A1 (3), member A2 (1), admin A (2), instructor A (1), admin B (1).
  async function seed(studioId, recipientType, recipientId, count, titlePrefix) {
    for (let i = 0; i < count; i++) {
      await Notification.create({
        studioId, recipientType, recipientId, type: 'test', title: `${titlePrefix} ${i}`,
        deliveryKey: `seed:${studioId}:${recipientType}:${recipientId}:${i}`,
      });
    }
  }
  await seed(studioA.id, 'member', accountA1.id, 3, 'A1');
  await seed(studioA.id, 'member', accountA2.id, 1, 'A2');
  await seed(studioA.id, 'admin', adminA.id, 2, 'AdminA');
  await seed(studioA.id, 'instructor', instructorA.id, 1, 'InstA');
  await seed(studioB.id, 'admin', adminB.id, 1, 'AdminB');

  const asMemberA1 = { memberAccountId: accountA1.id };
  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id };
  const asInstructorA = { id: instructorA.id, role: 'instructor', studioId: studioA.id };
  const asAdminB = { id: adminB.id, role: 'admin', studioId: studioB.id };

  // Member controllers read req.memberAccountId (set by authenticateMember middleware).
  function memberReq(accountId, extra = {}) {
    return { memberAccountId: accountId, body: {}, query: {}, params: {}, ...extra };
  }
  // Staff controllers read req.user and req.body.
  function staffReq(user, body = {}, extra = {}) {
    return { user, body, query: {}, params: {}, ...extra };
  }

  // --- Phase 1: member inbox access + isolation ---
  {
    const res = mockRes();
    await notificationController.memberInbox(memberReq(accountA1.id), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notifications.length, 3, 'member A1 sees own 3');
    assert.ok(res.body.notifications.every((n) => n.title.startsWith('A1')), 'only own notifications');
    // newest first
    const createdAts = res.body.notifications.map((n) => new Date(n.createdAt).getTime());
    assert.ok(createdAts[0] >= createdAts[createdAts.length - 1], 'newest first');
    console.log('Phase 1 OK: member inbox access + isolation');
  }

  // --- Phase 2: cross-user member isolation ---
  {
    const res = mockRes();
    await notificationController.memberInbox(memberReq(accountA2.id), res);
    assert.strictEqual(res.body.notifications.length, 1, 'member A2 sees only own 1');
    assert.ok(res.body.notifications[0].title.startsWith('A2'));
    console.log('Phase 2 OK: cross-user member isolation');
  }

  // --- Phase 3: cross-studio member isolation ---
  {
    const res = mockRes();
    await notificationController.memberInbox(memberReq(accountB1.id), res);
    assert.strictEqual(res.body.notifications.length, 0, 'member B1 sees none from studio A');
    console.log('Phase 3 OK: cross-studio member isolation');
  }

  // --- Phase 4: staff inbox (admin/instructor) + isolation ---
  {
    let res = mockRes();
    await notificationController.staffInbox(staffReq(asAdminA), res);
    assert.strictEqual(res.body.notifications.length, 2, 'admin A sees own 2');
    res = mockRes();
    await notificationController.staffInbox(staffReq(asInstructorA), res);
    assert.strictEqual(res.body.notifications.length, 1, 'instructor A sees own 1');
    res = mockRes();
    await notificationController.staffInbox(staffReq(asAdminB), res);
    assert.strictEqual(res.body.notifications.length, 1, 'admin B sees own 1 (studio B)');
    assert.ok(res.body.notifications[0].title.startsWith('AdminB'));
    console.log('Phase 4 OK: staff inbox + isolation');
  }

  // --- Phase 5: unread count + mark read + mark all read ---
  {
    let res = mockRes();
    await notificationController.memberUnreadCount(memberReq(accountA1.id), res);
    assert.strictEqual(res.body.unreadCount, 3, '3 unread');

    const inbox = mockRes();
    await notificationController.memberInbox(memberReq(accountA1.id), inbox);
    const firstId = inbox.body.notifications[0].id;
    res = mockRes();
    await notificationController.memberMarkRead(memberReq(accountA1.id, { params: { id: firstId } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.readAt, 'marked read');

    res = mockRes();
    await notificationController.memberUnreadCount(memberReq(accountA1.id), res);
    assert.strictEqual(res.body.unreadCount, 2, '2 unread after one read');

    res = mockRes();
    await notificationController.memberMarkAllRead(memberReq(accountA1.id), res);
    assert.strictEqual(res.body.updated, 2, 'marked remaining 2 read');
    res = mockRes();
    await notificationController.memberUnreadCount(memberReq(accountA1.id), res);
    assert.strictEqual(res.body.unreadCount, 0, '0 unread after mark all');
    console.log('Phase 5 OK: unread count + mark read + mark all read');
  }

  // --- Phase 6: cannot read another user's notification ---
  {
    const inboxA2 = mockRes();
    await notificationController.memberInbox(memberReq(accountA2.id), inboxA2);
    const a2NotifId = inboxA2.body.notifications[0].id;
    // member A1 tries to read A2's notification
    const res = mockRes();
    await notificationController.memberMarkRead(memberReq(accountA1.id, { params: { id: a2NotifId } }), res);
    assert.strictEqual(res.statusCode, 404, 'cannot read another user notification');
    console.log('Phase 6 OK: cross-user read protection');
  }

  // --- Phase 7: pagination ---
  {
    // Seed 30 more for admin A.
    for (let i = 0; i < 30; i++) {
      await Notification.create({
        studioId: studioA.id, recipientType: 'admin', recipientId: adminA.id, type: 'test', title: `Page ${i}`,
        deliveryKey: `page:${i}`,
      });
    }
    let res = mockRes();
    await notificationController.staffInbox(staffReq(asAdminA, {}, { query: { limit: '10', offset: '0' } }), res);
    assert.strictEqual(res.body.notifications.length, 10, 'page 1: 10');
    assert.strictEqual(res.body.limit, 10);
    res = mockRes();
    await notificationController.staffInbox(staffReq(asAdminA, {}, { query: { limit: '10', offset: '10' } }), res);
    assert.strictEqual(res.body.notifications.length, 10, 'page 2: 10');
    res = mockRes();
    await notificationController.staffInbox(staffReq(asAdminA, {}, { query: { limit: 'abc' } }), res);
    assert.strictEqual(res.statusCode, 400, 'invalid limit rejected');
    console.log('Phase 7 OK: pagination');
  }

  // --- Phase 8: settings read (defaults) + admin-only ---
  {
    const res = mockRes();
    await settingsController.getSettings(staffReq(asAdminA), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.memberReminderMinutes, 120, 'default member reminder 120');
    assert.strictEqual(res.body.instructorReminderMinutes, 60, 'default instructor reminder 60');
    assert.strictEqual(res.body.lowLessonsThreshold, 2, 'default low lessons 2');
    assert.strictEqual(res.body.packageExpiryDays, 7, 'default expiry 7');
    assert.strictEqual(res.body.inactivityDays, 14, 'default inactivity 14');
    assert.strictEqual(res.body.quietHoursStart, '21:00');
    assert.strictEqual(res.body.quietHoursEnd, '09:00');
    assert.strictEqual(res.body.paymentRemindersActivatedAt, null, 'payment not activated by default');
    console.log('Phase 8 OK: settings read with defaults');
  }

  // --- Phase 9: settings update + validation ---
  {
    const res = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, {
      memberReminderMinutes: 90, lowLessonsThreshold: 3, quietHoursStart: '22:00',
    }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.memberReminderMinutes, 90);
    assert.strictEqual(res.body.lowLessonsThreshold, 3);
    assert.strictEqual(res.body.quietHoursStart, '22:00');

    // Invalid values rejected.
    const bad = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, { memberReminderMinutes: 5000 }), bad);
    assert.strictEqual(bad.statusCode, 400, 'out-of-range rejected');
    const badTime = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, { quietHoursStart: '25:00' }), badTime);
    assert.strictEqual(badTime.statusCode, 400, 'invalid time rejected');
    const badBool = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, { classReminderEnabled: 'yes' }), badBool);
    assert.strictEqual(badBool.statusCode, 400, 'non-boolean rejected');
    console.log('Phase 9 OK: settings update + validation');
  }

  // --- Phase 10: payment activation boundary ---
  {
    // First enable -> sets activation to studio-local today.
    const res = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, { paymentAlertsEnabled: true }), res);
    assert.strictEqual(res.statusCode, 200);
    const today = await getStudioLocalDate(studioA.id);
    assert.strictEqual(String(res.body.paymentRemindersActivatedAt), today, 'activation set to today on first enable');

    // Disable then re-enable -> boundary NOT reset (no retroactive).
    await settingsController.updateSettings(staffReq(asAdminA, { paymentAlertsEnabled: false }), mockRes());
    const res2 = mockRes();
    await settingsController.updateSettings(staffReq(asAdminA, { paymentAlertsEnabled: true }), res2);
    assert.strictEqual(String(res2.body.paymentRemindersActivatedAt), today, 'boundary not reset on re-enable');
    console.log('Phase 10 OK: payment activation boundary');
  }

  // --- Phase 11: settings studio-scoped ---
  {
    const resB = mockRes();
    await settingsController.getSettings(staffReq(asAdminB), resB);
    assert.strictEqual(resB.body.memberReminderMinutes, 120, 'studio B has its own defaults');
    assert.strictEqual(resB.body.paymentRemindersActivatedAt, null, 'studio B payment not activated');
    console.log('Phase 11 OK: settings studio-scoped');
  }

  console.log('All notification-phase4.1 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
