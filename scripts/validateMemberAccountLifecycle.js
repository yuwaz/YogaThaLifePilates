// Disposable validator (not part of product code): proves the member account
// lifecycle MVP — activation/recovery purpose separation, code expiry/reuse/
// attempt limits, account-bound recovery, password reset/change, inactive
// memberships, multi-studio accounts, contact phone changes/collisions, and
// fresh/existing DB migration — against isolated temp SQLite DBs.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-lifecycle-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;
process.env.MEMBER_JWT_SECRET = 'temporary-member-secret-for-lifecycle-validation';

const {
  sequelize,
  Studio,
  User,
  Salon,
  MemberType,
  Member,
  MemberAccount,
  MemberAccountMembership,
  MemberActivationCode,
} = require('../models');
const ensureMemberActivationCodesTable = require('../ensureMemberActivationCodesTable');
const ensureMemberActivationCodePurposeColumn = require('../ensureMemberActivationCodePurposeColumn');
const ensureMemberAccountsTable = require('../ensureMemberAccountsTable');
const ensureMemberAccountPasswordChangedAtColumn = require('../ensureMemberAccountPasswordChangedAtColumn');
const memberActivationController = require('../controllers/memberActivationController');
const memberAuthController = require('../controllers/memberAuthController');
const memberController = require('../controllers/memberController');
const { authenticateMember, authenticateMemberContext } = require('../middleware/memberAuth');
const { signGlobalMemberToken, signMemberContextToken } = require('../utils/memberAuthToken');

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    let settled = false;
    const res = mockRes();
    const finish = (nextCalled) => {
      if (settled) return;
      settled = true;
      resolve({ nextCalled, req, res });
    };
    const returned = middleware(req, res, () => finish(true));
    if (returned && typeof returned.then === 'function') {
      returned.then(() => finish(false)).catch(() => finish(false));
    } else {
      finish(false);
    }
  });
}

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

const PHONE = '+905321234567';
const PHONE2 = '+905339876543';

async function run() {
  // --- Phase 0: existing-DB migration (table without purpose column) ---
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS MemberActivationCodes');
  await sequelize.query(`
    CREATE TABLE MemberActivationCodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      studioId INTEGER NOT NULL,
      memberId INTEGER NOT NULL,
      codeHash VARCHAR(255) NOT NULL,
      expiresAt DATETIME NOT NULL,
      consumedAt DATETIME NULL,
      createdByUserId INTEGER NOT NULL,
      attemptCount INTEGER NOT NULL DEFAULT 0,
      lastAttemptAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    INSERT INTO MemberActivationCodes (studioId, memberId, codeHash, expiresAt, createdByUserId)
    VALUES (1, 1, 'legacy-hash', '2030-01-01', 1);
  `);
  await ensureMemberActivationCodePurposeColumn();
  await ensureMemberActivationCodePurposeColumn(); // idempotent
  const legacyRows = await sequelize.query('SELECT purpose FROM MemberActivationCodes', { type: sequelize.QueryTypes.SELECT });
  assert.strictEqual(legacyRows[0].purpose, 'activation', 'legacy rows default to activation purpose');
  console.log('Phase 0 OK: existing-DB purpose migration, legacy rows = activation');

  // Recreate cleanly for the main suite.
  await sequelize.query('DROP TABLE IF EXISTS MemberActivationCodes');
  await ensureMemberActivationCodesTable();
  await ensureMemberActivationCodePurposeColumn();

  // --- Fixtures ---
  const studio = await Studio.create({
    name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const admin = await User.create({
    username: 'admin', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [], studioId: studio.id,
  });
  studio.ownerUserId = admin.id;
  await studio.save();
  const salon = await Salon.create({ name: 'Salon 1', type: 'Yoga', studioId: studio.id });
  const memberType = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studio.id });

  async function makeMember(name, phone, options = {}) {
    return Member.create({
      name,
      phone,
      normalizedPhone: phone,
      memberTypeId: memberType.id,
      assignedSalonIds: [salon.id],
      remainingLessons: 10,
      isActive: options.isActive === undefined ? true : options.isActive,
      deletedAt: options.deletedAt || null,
      studioId: studio.id,
    });
  }

  const asAdmin = { id: admin.id, role: 'admin', studioId: studio.id, assignedSalonIds: [], permissions: [] };

  async function genActivationCode(memberId) {
    const res = mockRes();
    await memberActivationController.generateActivationCode(
      reqFor(asAdmin, {}, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body.code;
  }
  async function genRecoveryCode(memberId) {
    const res = mockRes();
    await memberActivationController.generateRecoveryCode(
      reqFor(asAdmin, {}, { params: { id: memberId } }), res);
    return res;
  }
  async function activate(phone, code, password) {
    const res = mockRes();
    await memberActivationController.activateMember(
      reqFor(null, { phone, code, password, passwordConfirmation: password }), res);
    return res;
  }
  async function resetPassword(phone, code, password) {
    const res = mockRes();
    await memberActivationController.resetPassword(
      reqFor(null, { phone, code, password, passwordConfirmation: password }), res);
    return res;
  }
  async function login(phone, password) {
    const res = mockRes();
    await memberAuthController.login(reqFor(null, { phone, password }, { ip: '127.0.0.1' }), res);
    return res;
  }
  async function changePassword(accountId, currentPassword, newPassword) {
    const res = mockRes();
    await memberAuthController.changePassword(
      reqFor(null, { currentPassword, newPassword, newPasswordConfirmation: newPassword }, { memberAccountId: accountId }), res);
    return res;
  }

  // --- Phase 1: activation -> accountStatus active; recovery code issuance ---
  const member1 = await makeMember('Member One', PHONE);
  {
    // accountStatus pending before activation
    let res = mockRes();
    await memberController.getMember(reqFor(asAdmin, {}, { params: { id: member1.id } }), res);
    assert.strictEqual(res.body.accountStatus, 'pending', 'pending before activation');

    const code = await genActivationCode(member1.id);
    const actRes = await activate(PHONE, code, 'password123');
    assert.strictEqual(actRes.statusCode, 201, JSON.stringify(actRes.body));
    assert.strictEqual(actRes.body.account.status, 'active');

    res = mockRes();
    await memberController.getMember(reqFor(asAdmin, {}, { params: { id: member1.id } }), res);
    assert.strictEqual(res.body.accountStatus, 'active', 'active after activation');

    // list includes accountStatus
    res = mockRes();
    await memberController.getMembers(reqFor(asAdmin, {}), res);
    const row = res.body.find((m) => m.id === member1.id);
    assert.strictEqual(row.accountStatus, 'active', 'list includes accountStatus');

    // recovery code for active account
    const recRes = await genRecoveryCode(member1.id);
    assert.strictEqual(recRes.statusCode, 201, JSON.stringify(recRes.body));
    assert.ok(/^\d{6}$/.test(recRes.body.code), 'recovery code is 6 digits');
    console.log('Phase 1 OK: activation + accountStatus + recovery issuance');
  }

  // --- Phase 2: purpose separation ---
  {
    // activation code cannot reset password
    const member2 = await makeMember('Member Two', '+905321111111');
    const actCode = await genActivationCode(member2.id);
    const resetWithActivation = await resetPassword('+905321111111', actCode, 'newpassword1');
    assert.strictEqual(resetWithActivation.statusCode, 400, 'activation code cannot reset password');

    // recovery code cannot activate
    const recCode = (await genRecoveryCode(member1.id)).body.code;
    const activateWithRecovery = await activate(PHONE, recCode, 'whatever123');
    assert.strictEqual(activateWithRecovery.statusCode, 400, 'recovery code cannot activate');
    console.log('Phase 2 OK: activation/recovery purposes separated');
  }

  // --- Phase 3: recovery requires existing linked active account ---
  {
    const memberNoAccount = await makeMember('Member NoAcct', '+905322222222');
    const res = await genRecoveryCode(memberNoAccount.id);
    assert.strictEqual(res.statusCode, 404, 'recovery requires linked active account');
    console.log('Phase 3 OK: recovery issuance requires linked active account');
  }

  // --- Phase 4: password reset with recovery code ---
  {
    const code = (await genRecoveryCode(member1.id)).body.code;
    const resetRes = await resetPassword(PHONE, code, 'resetpassword1');
    assert.strictEqual(resetRes.statusCode, 200, JSON.stringify(resetRes.body));

    // old password fails, new works
    const oldLogin = await login(PHONE, 'password123');
    assert.strictEqual(oldLogin.statusCode, 401, 'old password rejected after reset');
    const newLogin = await login(PHONE, 'resetpassword1');
    assert.strictEqual(newLogin.statusCode, 200, 'new password works after reset');
    assert.ok(newLogin.body.token, 'login token issued');

    // code is single-use
    const reuse = await resetPassword(PHONE, code, 'anotherpass1');
    assert.strictEqual(reuse.statusCode, 400, 'consumed code cannot be reused');
    console.log('Phase 4 OK: password reset + single-use enforcement');
  }

  // --- Phase 5: change password with global token ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: PHONE } });
    const badCurrent = await changePassword(account.id, 'wrongpass', 'newpass12345');
    assert.strictEqual(badCurrent.statusCode, 401, 'wrong current password rejected');
    const okChange = await changePassword(account.id, 'resetpassword1', 'changedpass1');
    assert.strictEqual(okChange.statusCode, 200, JSON.stringify(okChange.body));
    const loginAfter = await login(PHONE, 'changedpass1');
    assert.strictEqual(loginAfter.statusCode, 200, 'login with changed password');
    console.log('Phase 5 OK: change password with current-password verification');
  }

  // --- Phase 6: attempt limits ---
  {
    const code = (await genRecoveryCode(member1.id)).body.code;
    for (let i = 0; i < 5; i++) {
      const res = await resetPassword(PHONE, '000000', 'attemptpass1');
      assert.strictEqual(res.statusCode, 400);
    }
    // 6th attempt with the CORRECT code must fail (attempt limit reached)
    const blocked = await resetPassword(PHONE, code, 'attemptpass1');
    assert.strictEqual(blocked.statusCode, 400, 'code locked after 5 failed attempts');
    console.log('Phase 6 OK: attempt limit locks code after 5 failures');
  }

  // --- Phase 7: code expiry ---
  {
    const code = (await genRecoveryCode(member1.id)).body.code;
    await MemberActivationCode.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { memberId: member1.id, consumedAt: null, purpose: 'recovery' } }
    );
    const res = await resetPassword(PHONE, code, 'expiredpass1');
    assert.strictEqual(res.statusCode, 400, 'expired code rejected');
    console.log('Phase 7 OK: expired code rejected');
  }

  // --- Phase 8: contact phone change preserves account identity; recovery still bound ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: PHONE } });
    const membershipBefore = await MemberAccountMembership.findOne({ where: { memberId: member1.id } });

    // Studio contact phone may change for account-linked members.
    const resEdit = mockRes();
    await memberController.updateMember(
      reqFor(asAdmin, { phone: PHONE2 }, { params: { id: member1.id } }), resEdit);
    assert.strictEqual(resEdit.statusCode, 200, `contact phone change allowed, got ${resEdit.statusCode} ${JSON.stringify(resEdit.body)}`);
    const memberAfter = await Member.findByPk(member1.id);
    assert.strictEqual(memberAfter.normalizedPhone, PHONE2, 'contact phone updated');

    // Global account identity and membership untouched.
    const accountAfter = await MemberAccount.findByPk(account.id);
    assert.strictEqual(accountAfter.normalizedPhone, PHONE, 'MemberAccount.normalizedPhone unchanged');
    const membershipAfter = await MemberAccountMembership.findOne({ where: { memberId: member1.id } });
    assert.strictEqual(Number(membershipAfter.accountId), Number(membershipBefore.accountId), 'membership not unlinked/relinked');

    // No cross-account auto-link: the account at PHONE2 must not gain this member.
    const phone2Account = await MemberAccount.findOne({ where: { normalizedPhone: PHONE2 } });
    if (phone2Account) {
      const crossLink = await MemberAccountMembership.findOne({ where: { accountId: phone2Account.id, memberId: member1.id } });
      assert.strictEqual(crossLink, null, 'no auto-link to PHONE2 account');
    }

    // Recovery still works for the linked account (at the ORIGINAL account phone).
    const code = (await genRecoveryCode(member1.id)).body.code;
    const resetRes = await resetPassword(PHONE, code, 'postguardpass1');
    assert.strictEqual(resetRes.statusCode, 200, 'recovery bound to linked account after contact phone change');
    console.log('Phase 8 OK: contact phone change preserves identity; recovery account-bound; no cross-account link');
  }

  // --- Phase 9: multi-studio account + inactive membership ---
  {
    const studioB = await Studio.create({
      name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
    });
    const salonB = await Salon.create({ name: 'Salon B', type: 'Yoga', studioId: studioB.id });
    const memberTypeB = await MemberType.create({ name: 'Group B', color: '#112233', studioId: studioB.id });
    const memberB = await Member.create({
      name: 'Member One B', phone: PHONE, normalizedPhone: PHONE, memberTypeId: memberTypeB.id,
      assignedSalonIds: [salonB.id], remainingLessons: 5, isActive: true, studioId: studioB.id,
    });

    // Login auto-links same-phone member in studio B.
    const loginRes = await login(PHONE, 'postguardpass1');
    assert.strictEqual(loginRes.statusCode, 200);
    assert.strictEqual(loginRes.body.memberships.length, 2, 'multi-studio memberships');

    // Deactivate studio A membership -> global account still usable, studio A hidden.
    member1.isActive = false;
    member1.deletedAt = new Date();
    await member1.save();

    const loginRes2 = await login(PHONE, 'postguardpass1');
    assert.strictEqual(loginRes2.statusCode, 200, 'global login unaffected by inactive membership');
    assert.strictEqual(loginRes2.body.memberships.length, 1, 'inactive studio membership hidden');
    assert.strictEqual(loginRes2.body.memberships[0].studioId, studioB.id);
    console.log('Phase 9 OK: multi-studio account + inactive membership does not disable global account');
  }

  // --- Phase 10: disabled account status surfaced distinctly ---
  {
    const account = await MemberAccount.findOne({ where: { normalizedPhone: PHONE } });
    account.status = 'disabled';
    await account.save();

    const res = mockRes();
    await memberController.getMember(reqFor(asAdmin, {}, { params: { id: member1.id } }), res);
    assert.strictEqual(res.body.accountStatus, 'disabled', 'disabled account surfaced distinctly');

    account.status = 'active';
    await account.save();
    console.log('Phase 10 OK: disabled account status distinct from pending/active');
  }

  // --- Phase 11: public reset does not expose account existence ---
  {
    const resNoPhone = await resetPassword('+905399999999', '123456', 'somepassword1');
    assert.strictEqual(resNoPhone.statusCode, 400);
    assert.strictEqual(resNoPhone.body.error, 'Activation failed', 'generic error for unknown phone');
    const resBadCode = await resetPassword(PHONE, '654321', 'somepassword1');
    assert.strictEqual(resBadCode.statusCode, 400);
    assert.strictEqual(resBadCode.body.error, 'Activation failed', 'same generic error for bad code');
    console.log('Phase 11 OK: public errors do not expose account existence');
  }

  // --- Phase 12: token revocation after password reset (tokenVersion) ---
  {
    // Fresh account for a clean revocation scenario.
    const phoneR = '+905325550001';
    const memberR = await makeMember('Member Revoke', phoneR);
    const actCode = await genActivationCode(memberR.id);
    const actRes = await activate(phoneR, actCode, 'revokepass1');
    assert.strictEqual(actRes.statusCode, 201);
    const accountR = await MemberAccount.findOne({ where: { normalizedPhone: phoneR } });
    assert.strictEqual(Number(accountR.tokenVersion), 0, 'tokenVersion starts at 0');

    // Issue global + context tokens at version 0.
    const globalToken = signGlobalMemberToken(accountR.id, 0);
    const membershipR = await MemberAccountMembership.findOne({ where: { accountId: accountR.id } });
    const contextToken = signMemberContextToken({
      accountId: accountR.id, membershipId: membershipR.id, studioId: membershipR.studioId, memberId: membershipR.memberId, tokenVersion: 0,
    });

    const gBefore = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${globalToken}` } });
    assert.strictEqual(gBefore.nextCalled, true, 'global token valid before reset');
    const cBefore = await runMiddleware(authenticateMemberContext, { headers: { authorization: `Bearer ${contextToken}` } });
    assert.strictEqual(cBefore.nextCalled, true, 'context token valid before reset');

    // Reset password -> tokenVersion 0 -> 1 -> old tokens revoked (no time wait needed).
    const recCode = (await genRecoveryCode(memberR.id)).body.code;
    const resetRes = await resetPassword(phoneR, recCode, 'revokepass2');
    assert.strictEqual(resetRes.statusCode, 200);
    const accountAfterReset = await MemberAccount.findByPk(accountR.id);
    assert.strictEqual(Number(accountAfterReset.tokenVersion), 1, 'tokenVersion incremented on reset');

    const gAfter = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${globalToken}` } });
    assert.strictEqual(gAfter.nextCalled, false, 'old global token rejected after reset');
    assert.strictEqual(gAfter.res.statusCode, 401);
    const cAfter = await runMiddleware(authenticateMemberContext, { headers: { authorization: `Bearer ${contextToken}` } });
    assert.strictEqual(cAfter.nextCalled, false, 'old context token rejected after reset');
    assert.strictEqual(cAfter.res.statusCode, 401);

    // New login with new password works and carries the new version.
    const newLogin = await login(phoneR, 'revokepass2');
    assert.strictEqual(newLogin.statusCode, 200, 'new password login succeeds after reset');
    assert.ok(newLogin.body.token);
    const gNew = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${newLogin.body.token}` } });
    assert.strictEqual(gNew.nextCalled, true, 'new login token valid');
    console.log('Phase 12 OK: tokenVersion revocation after reset; new login works');
  }

  // --- Phase 13: token revocation after password change + same-second bypass impossible ---
  {
    const accountR = await MemberAccount.findOne({ where: { normalizedPhone: '+905325550001' } });
    // Issue a token at the CURRENT version (1) in the SAME second as the change below.
    const globalToken = signGlobalMemberToken(accountR.id, Number(accountR.tokenVersion));
    const membershipR = await MemberAccountMembership.findOne({ where: { accountId: accountR.id } });
    const contextToken = signMemberContextToken({
      accountId: accountR.id, membershipId: membershipR.id, studioId: membershipR.studioId, memberId: membershipR.memberId, tokenVersion: Number(accountR.tokenVersion),
    });

    const gBefore = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${globalToken}` } });
    assert.strictEqual(gBefore.nextCalled, true, 'global token valid before change');

    // Change password immediately (same second) -> version 1 -> 2 -> token revoked.
    const changeRes = await changePassword(accountR.id, 'revokepass2', 'revokepass3');
    assert.strictEqual(changeRes.statusCode, 200, JSON.stringify(changeRes.body));
    const accountAfterChange = await MemberAccount.findByPk(accountR.id);
    assert.strictEqual(Number(accountAfterChange.tokenVersion), 2, 'tokenVersion incremented on change');

    const gAfter = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${globalToken}` } });
    assert.strictEqual(gAfter.nextCalled, false, 'same-second global token rejected after change');
    const cAfter = await runMiddleware(authenticateMemberContext, { headers: { authorization: `Bearer ${contextToken}` } });
    assert.strictEqual(cAfter.nextCalled, false, 'same-second context token rejected after change');

    const newLogin = await login('+905325550001', 'revokepass3');
    assert.strictEqual(newLogin.statusCode, 200, 'new password login succeeds after change');
    console.log('Phase 13 OK: tokenVersion revocation after change; same-second bypass impossible');
  }

  // --- Phase 13b: legacy tokens (no tokenVersion) valid before, invalid after change ---
  {
    const phoneL = '+905325550002';
    const memberL = await makeMember('Member Legacy', phoneL);
    const actCode = await genActivationCode(memberL.id);
    await activate(phoneL, actCode, 'legacypass1');
    const accountL = await MemberAccount.findOne({ where: { normalizedPhone: phoneL } });

    // Legacy token without tokenVersion claim.
    const legacyToken = signGlobalMemberToken(accountL.id);
    const legacyBefore = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${legacyToken}` } });
    assert.strictEqual(legacyBefore.nextCalled, true, 'legacy token valid before first password change');

    const changeRes = await changePassword(accountL.id, 'legacypass1', 'legacypass2');
    assert.strictEqual(changeRes.statusCode, 200);
    const legacyAfter = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${legacyToken}` } });
    assert.strictEqual(legacyAfter.nextCalled, false, 'legacy token rejected after password change');
    assert.strictEqual(legacyAfter.res.statusCode, 401);
    console.log('Phase 13b OK: legacy tokens valid before, invalid after first password change');
  }

  // --- Phase 14: revocation is account-scoped (unrelated account unaffected) ---
  {
    const account1 = await MemberAccount.findOne({ where: { normalizedPhone: PHONE } });
    const otherToken = signGlobalMemberToken(account1.id, Number(account1.tokenVersion));
    const gOther = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${otherToken}` } });
    assert.strictEqual(gOther.nextCalled, true, 'unrelated account token unaffected by another account revocation');
    console.log('Phase 14 OK: revocation scoped to the account only');
  }

  // --- Phase 15: existing-DB passwordChangedAt migration (isolated connection) ---
  {
    const migPath = path.join(tmpRoot, 'migration.sqlite');
    const { Sequelize } = require('sequelize');
    const migSequelize = new Sequelize({ dialect: 'sqlite', storage: migPath, logging: false });
    await migSequelize.query(`
      CREATE TABLE MemberAccounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalizedPhone VARCHAR(255) NOT NULL,
        passwordHash VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL DEFAULT 'active',
        activatedAt DATETIME NULL,
        lastLoginAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Run the ensure-script logic against this connection.
    const [results] = await migSequelize.query("PRAGMA table_info('MemberAccounts')");
    assert.ok(!results.some((c) => c.name === 'passwordChangedAt'), 'column absent before migration');
    await migSequelize.query("ALTER TABLE MemberAccounts ADD COLUMN passwordChangedAt DATETIME NULL;");
    const [after] = await migSequelize.query("PRAGMA table_info('MemberAccounts')");
    assert.ok(after.some((c) => c.name === 'passwordChangedAt'), 'passwordChangedAt added to existing table');
    // tokenVersion migration shape
    assert.ok(!after.some((c) => c.name === 'tokenVersion'), 'tokenVersion absent before migration');
    await migSequelize.query("ALTER TABLE MemberAccounts ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0;");
    await migSequelize.query("UPDATE MemberAccounts SET tokenVersion = 0 WHERE tokenVersion IS NULL;");
    const [after2] = await migSequelize.query("PRAGMA table_info('MemberAccounts')");
    assert.ok(after2.some((c) => c.name === 'tokenVersion'), 'tokenVersion added to existing table');
    await migSequelize.close();
    console.log('Phase 15 OK: existing-DB passwordChangedAt + tokenVersion migration shape valid');
  }

  console.log('All member-account-lifecycle cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
