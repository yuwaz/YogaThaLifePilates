const assert = require('assert');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const models = require('../models');
const memberAuthController = require('../controllers/memberAuthController');
const memberController = require('../controllers/memberController');
const { authenticateMember, authenticateMemberContext } = require('../middleware/memberAuth');
const {
  MEMBER_CONTEXT_TOKEN_TYPE,
  MEMBER_GLOBAL_TOKEN_TYPE,
  MEMBER_TOKEN_AUDIENCE,
  MEMBER_TOKEN_ISSUER,
  signGlobalMemberToken,
  verifyMemberToken,
} = require('../utils/memberAuthToken');
const {
  getAccessibleMemberships,
  LOGIN_MAX_FAILURES,
} = require('../services/memberAuthService');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

function assertDisposableDbPath() {
  assert.ok(process.env.DB_PATH, 'DB_PATH must be set for validation');
  const dbPath = path.resolve(process.env.DB_PATH);
  const repositoryDbPath = path.resolve(__dirname, '..', 'database.sqlite');
  assert.notStrictEqual(dbPath, repositoryDbPath, 'Refusing to force sync repository database.sqlite');
  assert.ok(
    dbPath.startsWith('/tmp/') || dbPath.startsWith('/var/folders/'),
    `Refusing to force sync non-disposable DB path: ${dbPath}`
  );
}

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    let settled = false;
    const res = response();
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

async function runController(controller, req) {
  const res = response();
  await controller(req, res);
  return res;
}

async function createStudio(name, code) {
  return models.Studio.create({ name, studioCode: code, country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
}

async function createSalon(studio, name) {
  return models.Salon.create({ name, type: 'Pilates', studioId: studio.id });
}

async function createMember(studio, name, phone, options = {}) {
  const type = await models.MemberType.create({ name: `${name} Type`, color: '#123456', studioId: studio.id });
  return models.Member.create({
    name,
    phone,
    normalizedPhone: options.normalizedPhone === undefined ? phone : options.normalizedPhone,
    memberTypeId: type.id,
    studioId: studio.id,
    isActive: options.isActive === undefined ? true : options.isActive,
    deletedAt: options.deletedAt || null,
  });
}

(async () => {
  process.env.MEMBER_JWT_SECRET = 'temporary-member-secret-for-validation';
  assertDisposableDbPath();
  await models.sequelize.sync({ force: true });

  const studioA = await createStudio('Studio A', 'studio-a');
  const studioB = await createStudio('Studio B', 'studio-b');
  const studioC = await createStudio('Studio C', 'studio-c');
  const studioD = await createStudio('Studio D', 'studio-d');
  const phone = '+905321234567';
  const memberA = await createMember(studioA, 'A', phone);
  const memberB = await createMember(studioB, 'B', phone);
  const inactiveMember = await createMember(studioC, 'Inactive', phone, { isActive: false });
  const deletedMember = await createMember(studioD, 'Deleted', phone, { deletedAt: new Date() });
  const passwordHash = await bcrypt.hash('member-password', 10);
  const account = await models.MemberAccount.create({ normalizedPhone: phone, passwordHash, status: 'active', activatedAt: new Date('2026-01-01T00:00:00.000Z') });
  await models.MemberAccountMembership.bulkCreate([
    { accountId: account.id, studioId: studioA.id, memberId: memberA.id },
    { accountId: account.id, studioId: studioB.id, memberId: memberB.id },
    { accountId: account.id, studioId: studioC.id, memberId: inactiveMember.id },
    { accountId: account.id, studioId: studioD.id, memberId: deletedMember.id },
  ]);
  const userBefore = await models.User.count();
  const memberPhoneBefore = memberA.phone;
  const activatedAtBefore = account.activatedAt.getTime();

  const login = await runController(memberAuthController.login, { ip: '10.0.0.1', body: { phone: '0532 123 45 67', password: 'member-password' } });
  assert.strictEqual(login.statusCode, 200);
  assert.strictEqual(login.body.account.id, account.id);
  assert.strictEqual(login.body.memberships.length, 2);
  assert.strictEqual(login.body.requiresStudioSelection, true);
  assert.ok(login.body.memberships.every((membership) => membership.memberId === memberA.id || membership.memberId === memberB.id));
  const decoded = jwt.verify(login.body.token, process.env.MEMBER_JWT_SECRET, { issuer: MEMBER_TOKEN_ISSUER, audience: MEMBER_TOKEN_AUDIENCE });
  assert.strictEqual(decoded.tokenType, MEMBER_GLOBAL_TOKEN_TYPE);
  assert.strictEqual(decoded.accountId, account.id);
  assert.strictEqual(decoded.memberId, undefined);
  assert.strictEqual(decoded.studioId, undefined);

  const afterLogin = await models.MemberAccount.findByPk(account.id);
  assert.ok(afterLogin.lastLoginAt);
  assert.strictEqual(afterLogin.passwordHash, passwordHash);
  assert.strictEqual(afterLogin.activatedAt.getTime(), activatedAtBefore);
  assert.strictEqual((await models.Member.findByPk(memberA.id)).phone, memberPhoneBefore);
  assert.strictEqual(await models.User.count(), userBefore);

  const internationalAccount = await models.MemberAccount.create({ normalizedPhone: '+14155552671', passwordHash: await bcrypt.hash('international-password', 10), status: 'active' });
  const internationalLogin = await runController(memberAuthController.login, { ip: '10.0.0.8', body: { phone: '+1 415 555 2671', password: 'international-password' } });
  assert.strictEqual(internationalLogin.statusCode, 200);
  assert.strictEqual(internationalLogin.body.memberships.length, 0);
  assert.strictEqual(internationalLogin.body.requiresStudioSelection, false);
  assert.strictEqual(internationalLogin.body.account.id, internationalAccount.id);

  const meReq = { headers: { authorization: `Bearer ${login.body.token}` } };
  const meAuth = await runMiddleware(authenticateMember, meReq);
  assert.strictEqual(meAuth.nextCalled, true);
  assert.strictEqual(meReq.memberAccountId, account.id);
  assert.strictEqual(meReq.user, undefined);
  const me = await runController(memberAuthController.getMe, meReq);
  assert.strictEqual(me.statusCode, 200);
  assert.strictEqual(me.body.memberships.length, 2);

  const createTimePhone = '+905321234573';
  const createTimeStudioA = await createStudio('Create Time A', 'create-time-a');
  const createTimeStudioB = await createStudio('Create Time B', 'create-time-b');
  const createTimeMemberA = await createMember(createTimeStudioA, 'Create Time A Member', createTimePhone);
  const createTimeAccount = await models.MemberAccount.create({ normalizedPhone: createTimePhone, passwordHash: await bcrypt.hash('create-time-password', 10), status: 'active', activatedAt: new Date() });
  await models.MemberAccountMembership.create({ accountId: createTimeAccount.id, studioId: createTimeStudioA.id, memberId: createTimeMemberA.id });
  const createTimeType = await models.MemberType.create({ name: 'Create Time B Type', color: '#123456', studioId: createTimeStudioB.id });
  const createTimeSalon = await createSalon(createTimeStudioB, 'Create Time B Salon');
  const createTimeResult = await runController(memberController.createMember, {
    user: { id: 501, role: 'admin', studioId: createTimeStudioB.id },
    body: {
      name: 'Create Time B Member',
      phone: createTimePhone,
      memberTypeId: createTimeType.id,
      assignedSalonIds: [createTimeSalon.id],
    },
  });
  assert.strictEqual(createTimeResult.statusCode, 201);
  assert.ok(await models.MemberAccountMembership.findOne({ where: { accountId: createTimeAccount.id, studioId: createTimeStudioB.id, memberId: createTimeResult.body.id } }));

  const historicalPhone = '+905321234574';
  const historicalStudioA = await createStudio('Historical A', 'historical-a');
  const historicalStudioB = await createStudio('Historical B', 'historical-b');
  const historicalMemberA = await createMember(historicalStudioA, 'Historical A Member', historicalPhone);
  const historicalMemberB = await createMember(historicalStudioB, 'Historical B Member', historicalPhone);
  const historicalAccount = await models.MemberAccount.create({ normalizedPhone: historicalPhone, passwordHash: await bcrypt.hash('historical-password', 10), status: 'active', activatedAt: new Date() });
  await models.MemberAccountMembership.create({ accountId: historicalAccount.id, studioId: historicalStudioA.id, memberId: historicalMemberA.id });
  const historicalLogin = await runController(memberAuthController.login, { ip: '10.0.0.9', body: { phone: historicalPhone, password: 'historical-password' } });
  assert.strictEqual(historicalLogin.statusCode, 200);
  assert.strictEqual(historicalLogin.body.memberships.length, 2);
  assert.ok(historicalLogin.body.memberships.some((membership) => membership.memberId === historicalMemberB.id));
  assert.strictEqual(await models.MemberAccountMembership.count({ where: { accountId: historicalAccount.id } }), 2);
  const historicalMeReq = { headers: { authorization: `Bearer ${historicalLogin.body.token}` } };
  const historicalMeAuth = await runMiddleware(authenticateMember, historicalMeReq);
  assert.strictEqual(historicalMeAuth.nextCalled, true);
  const historicalMe = await runController(memberAuthController.getMe, historicalMeReq);
  assert.strictEqual(historicalMe.statusCode, 200);
  assert.strictEqual(historicalMe.body.memberships.length, 2);
  const historicalSecondLogin = await runController(memberAuthController.login, { ip: '10.0.0.10', body: { phone: historicalPhone, password: 'historical-password' } });
  assert.strictEqual(historicalSecondLogin.statusCode, 200);
  assert.strictEqual(await models.MemberAccountMembership.count({ where: { accountId: historicalAccount.id } }), 2);

  const conflictPhone = '+905321234575';
  const conflictStudio = await createStudio('Conflict Studio', 'conflict-studio');
  const conflictMember = await createMember(conflictStudio, 'Conflict Member', conflictPhone);
  const conflictAccount = await models.MemberAccount.create({ normalizedPhone: conflictPhone, passwordHash: await bcrypt.hash('conflict-password', 10), status: 'active', activatedAt: new Date() });
  const otherConflictAccount = await models.MemberAccount.create({ normalizedPhone: '+905321234576', passwordHash: await bcrypt.hash('other-conflict-password', 10), status: 'active', activatedAt: new Date() });
  await models.MemberAccountMembership.create({ accountId: otherConflictAccount.id, studioId: conflictStudio.id, memberId: conflictMember.id });
  const conflictLogin = await runController(memberAuthController.login, { ip: '10.0.0.11', body: { phone: conflictPhone, password: 'conflict-password' } });
  assert.strictEqual(conflictLogin.statusCode, 200);
  assert.strictEqual(conflictLogin.body.memberships.length, 0);
  assert.ok(await models.MemberAccountMembership.findOne({ where: { accountId: otherConflictAccount.id, studioId: conflictStudio.id, memberId: conflictMember.id } }));
  assert.strictEqual(await models.MemberAccountMembership.count({ where: { accountId: conflictAccount.id, memberId: conflictMember.id } }), 0);

  const duplicateStudioPhone = '+905321234577';
  const duplicateStudio = await createStudio('Duplicate Studio', 'duplicate-studio');
  const duplicateAccount = await models.MemberAccount.create({ normalizedPhone: duplicateStudioPhone, passwordHash: await bcrypt.hash('duplicate-password', 10), status: 'active', activatedAt: new Date() });
  const existingStudioMember = await createMember(duplicateStudio, 'Existing Studio Member', '+905321234578');
  const skippedSamePhoneMember = await createMember(duplicateStudio, 'Skipped Same Phone Member', duplicateStudioPhone);
  await models.MemberAccountMembership.create({ accountId: duplicateAccount.id, studioId: duplicateStudio.id, memberId: existingStudioMember.id });
  const duplicateLogin = await runController(memberAuthController.login, { ip: '10.0.0.12', body: { phone: duplicateStudioPhone, password: 'duplicate-password' } });
  assert.strictEqual(duplicateLogin.statusCode, 200);
  assert.strictEqual(duplicateLogin.body.memberships.length, 1);
  assert.strictEqual(duplicateLogin.body.memberships[0].memberId, existingStudioMember.id);
  assert.strictEqual(await models.MemberAccountMembership.count({ where: { accountId: duplicateAccount.id, memberId: skippedSamePhoneMember.id } }), 0);

  const selected = await runController(memberAuthController.selectMembership, {
    memberAccountId: account.id,
    body: { membershipId: login.body.memberships[0].membershipId, memberId: memberB.id, studioId: studioB.id },
  });
  assert.strictEqual(selected.statusCode, 200);
  const contextDecoded = verifyMemberToken(selected.body.contextToken, MEMBER_CONTEXT_TOKEN_TYPE);
  assert.strictEqual(contextDecoded.tokenType, MEMBER_CONTEXT_TOKEN_TYPE);
  assert.strictEqual(contextDecoded.accountId, account.id);
  assert.strictEqual(contextDecoded.memberId, memberA.id);
  assert.strictEqual(contextDecoded.studioId, studioA.id);
  assert.strictEqual(selected.body.membership.memberId, memberA.id);

  const contextReq = { headers: { authorization: `Bearer ${selected.body.contextToken}` } };
  const contextAuth = await runMiddleware(authenticateMemberContext, contextReq);
  assert.strictEqual(contextAuth.nextCalled, true);
  assert.strictEqual(contextReq.memberId, memberA.id);
  assert.strictEqual(contextReq.memberStudioId, studioA.id);
  const contextAsGlobal = await runMiddleware(authenticateMember, contextReq);
  assert.strictEqual(contextAsGlobal.nextCalled, false);

  const secondMembership = login.body.memberships.find((membership) => membership.memberId === memberB.id);
  const switched = await runController(memberAuthController.selectMembership, {
    memberAccountId: account.id,
    body: { membershipId: secondMembership.membershipId },
  });
  const switchedDecoded = verifyMemberToken(switched.body.contextToken, MEMBER_CONTEXT_TOKEN_TYPE);
  assert.strictEqual(switchedDecoded.memberId, memberB.id);
  assert.strictEqual(switchedDecoded.studioId, studioB.id);
  assert.strictEqual((await models.MemberAccount.findByPk(account.id)).lastLoginAt.getTime(), afterLogin.lastLoginAt.getTime());

  const otherAccount = await models.MemberAccount.create({ normalizedPhone: '+905321234568', passwordHash: await bcrypt.hash('other-password', 10), status: 'active' });
  const otherMember = await createMember(studioC, 'Other', '+905321234568');
  const otherMembership = await models.MemberAccountMembership.create({ accountId: otherAccount.id, studioId: studioC.id, memberId: otherMember.id });
  const forbiddenSelection = await runController(memberAuthController.selectMembership, { memberAccountId: account.id, body: { membershipId: otherMembership.id } });
  assert.strictEqual(forbiddenSelection.statusCode, 403);

  const staffToken = jwt.sign({ id: 999, role: 'admin', studioId: studioA.id }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '30d' });
  const staffAsMember = await runMiddleware(authenticateMember, { headers: { authorization: `Bearer ${staffToken}` } });
  assert.strictEqual(staffAsMember.nextCalled, false);
  assert.throws(() => verifyMemberToken(login.body.token, MEMBER_CONTEXT_TOKEN_TYPE));

  const disabled = await models.MemberAccount.create({ normalizedPhone: '+905321234569', passwordHash: await bcrypt.hash('disabled-password', 10), status: 'disabled' });
  const disabledBefore = disabled.lastLoginAt;
  const disabledLogin = await runController(memberAuthController.login, { ip: '10.0.0.2', body: { phone: '+905321234569', password: 'disabled-password' } });
  assert.strictEqual(disabledLogin.statusCode, 401);
  assert.strictEqual(disabledLogin.body.error, 'Invalid phone or password');
  assert.strictEqual((await models.MemberAccount.findByPk(disabled.id)).lastLoginAt, disabledBefore || null);

  const unknownLogin = await runController(memberAuthController.login, { ip: '10.0.0.3', body: { phone: '+905321234570', password: 'wrong' } });
  const wrongLogin = await runController(memberAuthController.login, { ip: '10.0.0.4', body: { phone, password: 'wrong' } });
  assert.strictEqual(unknownLogin.statusCode, wrongLogin.statusCode);
  assert.strictEqual(unknownLogin.body.error, wrongLogin.body.error);

  const limitedPhone = '+905321234571';
  const limitedAccount = await models.MemberAccount.create({ normalizedPhone: limitedPhone, passwordHash: await bcrypt.hash('limited-password', 10), status: 'active' });
  for (let attempt = 0; attempt < LOGIN_MAX_FAILURES; attempt += 1) {
    const failure = await runController(memberAuthController.login, { ip: '10.0.0.5', body: { phone: limitedPhone, password: 'wrong' } });
    assert.strictEqual(failure.statusCode, 401);
  }
  const locked = await runController(memberAuthController.login, { ip: '10.0.0.5', body: { phone: limitedPhone, password: 'limited-password' } });
  assert.strictEqual(locked.statusCode, 401);
  assert.strictEqual((await models.MemberAccount.findByPk(limitedAccount.id)).lastLoginAt, null);

  const resetPhone = '+905321234572';
  const resetAccount = await models.MemberAccount.create({ normalizedPhone: resetPhone, passwordHash: await bcrypt.hash('reset-password', 10), status: 'active' });
  const resetFailure = await runController(memberAuthController.login, { ip: '10.0.0.6', body: { phone: resetPhone, password: 'wrong' } });
  assert.strictEqual(resetFailure.statusCode, 401);
  const resetSuccess = await runController(memberAuthController.login, { ip: '10.0.0.6', body: { phone: resetPhone, password: 'reset-password' } });
  assert.strictEqual(resetSuccess.statusCode, 200);
  const resetAgain = await runController(memberAuthController.login, { ip: '10.0.0.6', body: { phone: resetPhone, password: 'wrong' } });
  assert.strictEqual(resetAgain.statusCode, 401);

  const missingSecret = process.env.MEMBER_JWT_SECRET;
  delete process.env.MEMBER_JWT_SECRET;
  const missingSecretLogin = await runController(memberAuthController.login, { ip: '10.0.0.7', body: { phone: resetPhone, password: 'reset-password' } });
  assert.strictEqual(missingSecretLogin.statusCode, 500);
  process.env.MEMBER_JWT_SECRET = missingSecret;

  assert.strictEqual((await getAccessibleMemberships(account.id)).length, 2);
  console.log('member auth validation passed');
  await models.sequelize.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
