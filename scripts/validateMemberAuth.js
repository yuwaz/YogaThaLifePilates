const assert = require('assert');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const models = require('../models');
const memberAuthController = require('../controllers/memberAuthController');
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
  };
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
