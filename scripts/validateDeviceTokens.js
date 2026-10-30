// Disposable validator (not part of product code): proves device token
// registration — staff/member registration, idempotency, ownership protection,
// cross-studio isolation, token refresh/takeover, invalid inputs, migration
// safety — on isolated temp SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'device-tokens-'));
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
  DeviceToken,
} = require('../models');
const ensureDeviceTokensTable = require('../ensureDeviceTokensTable');
const deviceTokenService = require('../services/deviceTokenService');
const deviceTokenController = require('../controllers/deviceTokenController');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
  return res;
}

const TOKEN_A = 'fcm-token-aaaa-bbbb-cccc-dddd';
const TOKEN_B = 'fcm-token-eeee-ffff-0000-1111';
const TOKEN_C = 'fcm-token-2222-3333-4444-5555';

async function run() {
  // --- Phase 0: fresh + existing DB migration ---
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS DeviceTokens');
  await ensureDeviceTokensTable();
  await ensureDeviceTokensTable(); // idempotent
  const [rows] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table' AND name='DeviceTokens'");
  assert.strictEqual(rows.length, 1, 'DeviceTokens created');
  console.log('Phase 0 OK: fresh + idempotent migration');

  // --- Fixtures ---
  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
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
  const accountA = await makeMemberAccount('+905328810001', studioA.id);
  const accountB = await makeMemberAccount('+905328810002', studioB.id);

  // --- Phase 1: staff registration ---
  {
    const res = mockRes();
    await deviceTokenController.staffRegisterDevice(
      { user: { id: adminA.id, role: 'admin', studioId: studioA.id }, body: { token: TOKEN_A, platform: 'ios' } }, res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    const row = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    assert.ok(row, 'token stored');
    assert.strictEqual(row.ownerType, 'staff');
    assert.strictEqual(Number(row.ownerId), adminA.id);
    assert.strictEqual(Number(row.studioId), studioA.id);
    assert.strictEqual(row.platform, 'ios');
    console.log('Phase 1 OK: staff registration');
  }

  // --- Phase 2: member global-token registration ---
  {
    const res = mockRes();
    await deviceTokenController.memberRegisterDevice(
      { memberAccountId: accountA.id, body: { token: TOKEN_B, platform: 'android' } }, res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    const row = await DeviceToken.findOne({ where: { token: TOKEN_B } });
    assert.strictEqual(row.ownerType, 'member');
    assert.strictEqual(Number(row.ownerId), accountA.id);
    assert.strictEqual(row.studioId, null, 'member token is global (no studioId)');
    console.log('Phase 2 OK: member global-token registration');
  }

  // --- Phase 3: multiple devices per account ---
  {
    const res = mockRes();
    await deviceTokenController.staffRegisterDevice(
      { user: { id: adminA.id, role: 'admin', studioId: studioA.id }, body: { token: TOKEN_C, platform: 'android' } }, res);
    assert.strictEqual(res.statusCode, 201);
    const count = await DeviceToken.count({ where: { ownerType: 'staff', ownerId: adminA.id } });
    assert.strictEqual(count, 2, 'admin A has 2 devices');
    console.log('Phase 3 OK: multiple devices per account');
  }

  // --- Phase 4: idempotent registration (refresh lastSeenAt) ---
  {
    const before = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    const firstSeen = before.lastSeenAt;
    await new Promise((r) => setTimeout(r, 1100));
    const res = mockRes();
    await deviceTokenController.staffRegisterDevice(
      { user: { id: adminA.id, role: 'admin', studioId: studioA.id }, body: { token: TOKEN_A, platform: 'ios' } }, res);
    assert.strictEqual(res.statusCode, 200, 're-registration returns 200 (not 201)');
    assert.strictEqual(res.body.created, false, 'not created (refreshed)');
    const after = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    assert.ok(new Date(after.lastSeenAt) > new Date(firstSeen), 'lastSeenAt updated');
    const count = await DeviceToken.count({ where: { token: TOKEN_A } });
    assert.strictEqual(count, 1, 'no duplicate row');
    console.log('Phase 4 OK: idempotent registration / token refresh');
  }

  // --- Phase 5: token takeover (shared-device account switching) ---
  {
    // TOKEN_A currently owned by adminA (staff, studio A). Member A registers it.
    const res = mockRes();
    await deviceTokenController.memberRegisterDevice(
      { memberAccountId: accountA.id, body: { token: TOKEN_A, platform: 'ios' } }, res);
    assert.strictEqual(res.statusCode, 200, 'takeover returns 200');
    const row = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    assert.strictEqual(row.ownerType, 'member', 'token reassigned to member');
    assert.strictEqual(Number(row.ownerId), accountA.id);
    assert.strictEqual(row.studioId, null, 'studioId cleared on member takeover');
    const count = await DeviceToken.count({ where: { token: TOKEN_A } });
    assert.strictEqual(count, 1, 'still one row (no duplicate)');
    console.log('Phase 5 OK: token takeover (shared-device account switching)');
  }

  // --- Phase 6: unregister only owned tokens ---
  {
    // adminB (staff, studio B) tries to unregister TOKEN_A (now owned by member accountA).
    const res = mockRes();
    await deviceTokenController.staffUnregisterDevice(
      { user: { id: adminB.id, role: 'admin', studioId: studioB.id }, body: { token: TOKEN_A } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removed, false, 'cannot remove another owner token');
    const stillThere = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    assert.ok(stillThere, 'token not removed');

    // Owner (member accountA) unregisters.
    const res2 = mockRes();
    await deviceTokenController.memberUnregisterDevice(
      { memberAccountId: accountA.id, body: { token: TOKEN_A } }, res2);
    assert.strictEqual(res2.body.removed, true, 'owner can remove');
    const gone = await DeviceToken.findOne({ where: { token: TOKEN_A } });
    assert.strictEqual(gone, null, 'token removed');
    console.log('Phase 6 OK: unregister only owned tokens');
  }

  // --- Phase 7: cross-studio isolation (staff) ---
  {
    // adminA (studio A) registers TOKEN_C (already registered by adminA in Phase 3).
    // adminB (studio B) tries to unregister it -> not owner (different studio).
    const res = mockRes();
    await deviceTokenController.staffUnregisterDevice(
      { user: { id: adminB.id, role: 'admin', studioId: studioB.id }, body: { token: TOKEN_C } }, res);
    assert.strictEqual(res.body.removed, false, 'cross-studio unregister blocked');
    // adminA (owner, studio A) can unregister.
    const res2 = mockRes();
    await deviceTokenController.staffUnregisterDevice(
      { user: { id: adminA.id, role: 'admin', studioId: studioA.id }, body: { token: TOKEN_C } }, res2);
    assert.strictEqual(res2.body.removed, true, 'owner same-studio unregister works');
    console.log('Phase 7 OK: cross-studio isolation');
  }

  // --- Phase 8: invalid inputs rejected ---
  {
    for (const [label, body] of [
      ['missing token', { platform: 'ios' }],
      ['short token', { token: 'abc', platform: 'ios' }],
      ['invalid platform', { token: TOKEN_A, platform: 'windows' }],
      ['missing platform', { token: TOKEN_A }],
    ]) {
      const res = mockRes();
      await deviceTokenController.staffRegisterDevice(
        { user: { id: adminA.id, role: 'admin', studioId: studioA.id }, body }, res);
      assert.strictEqual(res.statusCode, 400, `${label} rejected`);
    }
    console.log('Phase 8 OK: invalid inputs rejected');
  }

  // --- Phase 9: context token cannot register (member uses global only) ---
  {
    // The member route uses authenticateMember (global token). A context token
    // would be rejected by middleware; here we verify the controller requires
    // memberAccountId (set only by global-token middleware).
    const res = mockRes();
    await deviceTokenController.memberRegisterDevice(
      { body: { token: TOKEN_B, platform: 'ios' } }, res); // no memberAccountId
    assert.strictEqual(res.statusCode, 400, 'missing memberAccountId rejected');
    console.log('Phase 9 OK: context token cannot register (memberAccountId required)');
  }

  console.log('All device-token cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
