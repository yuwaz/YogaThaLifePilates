const assert = require('assert');
const bcrypt = require('bcrypt');
const { authorizeRoles } = require('../middleware/auth');
const activationController = require('../controllers/memberActivationController');
const {
  sequelize,
  Studio,
  User,
  Member,
  MemberType,
  MemberAccount,
  MemberAccountMembership,
  MemberActivationCode,
} = require('../models');
const {
  generateActivationCode,
  activateMember,
} = require('../services/memberActivationService');

async function createStudio(name, code) {
  return Studio.create({
    name,
    studioCode: code,
    country: 'TR',
    currency: 'TRY',
    timezone: 'Europe/Istanbul',
  });
}

async function createMember(studio, name, phone) {
  const memberType = await MemberType.create({
    name: `${name} type`,
    color: '#123456',
    studioId: studio.id,
  });
  return Member.create({
    name,
    phone,
    memberTypeId: memberType.id,
    normalizedPhone: phone,
    studioId: studio.id,
  });
}

function runMiddleware(middleware, req) {
  let nextCalled = false;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
  middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode: res.statusCode };
}

async function runController(controller, req) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
  await controller(req, response);
  return response;
}

(async () => {
  await sequelize.sync({ force: true });

  const studioA = await createStudio('Studio A', 'studio-a');
  const studioB = await createStudio('Studio B', 'studio-b');
  const studioC = await createStudio('Studio C', 'studio-c');
  const adminA = await User.create({ username: 'admin-a', password: 'hash', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instructor-a', password: 'hash', role: 'instructor', studioId: studioA.id });

  const phone = '+905321234567';
  const memberA1 = await createMember(studioA, 'A1', phone);
  const memberA2 = await createMember(studioA, 'A2', phone);
  const memberB = await createMember(studioB, 'B', phone);
  const memberC = await createMember(studioC, 'C', phone);

  const adminOnly = runMiddleware(authorizeRoles(['admin']), { user: instructorA });
  assert.strictEqual(adminOnly.nextCalled, false);
  assert.strictEqual(adminOnly.statusCode, 403);

  const adminGeneration = await runController(activationController.generateActivationCode, {
    user: adminA,
    params: { id: memberA1.id },
  });
  assert.strictEqual(adminGeneration.statusCode, 201);
  assert.match(adminGeneration.body.code, /^\d{6}$/);

  const crossStudioGeneration = await runController(activationController.generateActivationCode, {
    user: adminA,
    params: { id: memberB.id },
  });
  assert.strictEqual(crossStudioGeneration.statusCode, 404);

  const firstCode = await generateActivationCode({ studioId: studioA.id, memberId: memberA1.id, createdByUserId: adminA.id });
  assert.match(firstCode.code, /^\d{6}$/);
  const firstStored = await MemberActivationCode.findOne({ where: { memberId: memberA1.id, consumedAt: null } });
  assert.notStrictEqual(firstStored.codeHash, firstCode.code);
  assert.strictEqual(await bcrypt.compare(firstCode.code, firstStored.codeHash), true);
  assert.ok(firstCode.expiresAt.getTime() - Date.now() > 23 * 60 * 60 * 1000);

  const secondCode = await generateActivationCode({ studioId: studioA.id, memberId: memberA1.id, createdByUserId: adminA.id });
  const activeCodes = await MemberActivationCode.count({ where: { studioId: studioA.id, memberId: memberA1.id, consumedAt: null } });
  assert.strictEqual(activeCodes, 1);
  const invalidatedFirst = await MemberActivationCode.findByPk(firstStored.id);
  assert.ok(invalidatedFirst.consumedAt);

  const activated = await activateMember({
    phone,
    code: secondCode.code,
    password: 'member-password',
    passwordConfirmation: 'member-password',
  });
  assert.strictEqual(activated.account.status, 'active');
  assert.strictEqual(activated.memberships.length, 3);
  assert.strictEqual(activated.requiresStudioSelection, true);
  assert.ok(activated.memberships.some((membership) => membership.memberId === memberA1.id));
  assert.ok(activated.memberships.some((membership) => membership.memberId === memberB.id));
  assert.ok(activated.memberships.some((membership) => membership.memberId === memberC.id));
  assert.ok(!activated.memberships.some((membership) => membership.memberId === memberA2.id));
  assert.strictEqual(await MemberActivationCode.count({ where: { memberId: memberA1.id, consumedAt: null } }), 0);
  assert.strictEqual(await MemberAccount.count(), 1);
  const account = await MemberAccount.findOne({ where: { normalizedPhone: phone } });
  assert.strictEqual(await bcrypt.compare('member-password', account.passwordHash), true);
  assert.strictEqual(await MemberAccountMembership.count(), 3);

  const passwordBefore = account.passwordHash;
  const activatedAtBefore = account.activatedAt.getTime();
  const studioD = await createStudio('Studio D', 'studio-d');
  const memberD = await createMember(studioD, 'D', phone);
  const adminD = await User.create({ username: 'admin-d', password: 'hash', role: 'admin', studioId: studioD.id });
  const existingAccountCode = await generateActivationCode({ studioId: studioD.id, memberId: memberD.id, createdByUserId: adminD.id });
  const existingAccountResult = await activateMember({ phone, code: existingAccountCode.code, password: 'different-password', passwordConfirmation: 'different-password' });
  assert.strictEqual(existingAccountResult.account.id, account.id);
  const accountAfterReuse = await MemberAccount.findByPk(account.id);
  assert.strictEqual(accountAfterReuse.passwordHash, passwordBefore);
  assert.strictEqual(accountAfterReuse.activatedAt.getTime(), activatedAtBefore);
  assert.ok(existingAccountResult.memberships.some((membership) => membership.memberId === memberD.id));

  const studioE = await createStudio('Studio E', 'studio-e');
  const memberE = await createMember(studioE, 'E', '+905321234568');
  const adminE = await User.create({ username: 'admin-e', password: 'hash', role: 'admin', studioId: studioE.id });
  const accountE = await MemberAccount.create({ normalizedPhone: '+905321234599', passwordHash: await bcrypt.hash('existing', 10), status: 'active', activatedAt: new Date() });
  await MemberAccountMembership.create({ accountId: accountE.id, studioId: studioE.id, memberId: memberE.id });
  const conflictCode = await generateActivationCode({ studioId: studioE.id, memberId: memberE.id, createdByUserId: adminE.id });
  await assert.rejects(() => activateMember({ phone: '+905321234568', code: conflictCode.code, password: 'new-password', passwordConfirmation: 'new-password' }));
  assert.strictEqual(await MemberAccount.count({ where: { normalizedPhone: '+905321234568' } }), 0);
  assert.strictEqual(await MemberAccount.count({ where: { normalizedPhone: '+905321234599' } }), 1);

  const studioF = await createStudio('Studio F', 'studio-f');
  const memberF = await createMember(studioF, 'F', '+905321234569');
  const adminF = await User.create({ username: 'admin-f', password: 'hash', role: 'admin', studioId: studioF.id });
  const wrongCode = await generateActivationCode({ studioId: studioF.id, memberId: memberF.id, createdByUserId: adminF.id });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() => activateMember({ phone: '+905321234569', code: '000000', password: 'member-password', passwordConfirmation: 'member-password' }));
  }
  const failedCode = await MemberActivationCode.findByPk(wrongCode.code ? (await MemberActivationCode.findOne({ where: { memberId: memberF.id } })).id : null);
  assert.strictEqual(failedCode.attemptCount, 5);
  await assert.rejects(() => activateMember({ phone: '+905321234569', code: wrongCode.code, password: 'member-password', passwordConfirmation: 'member-password' }));
  assert.strictEqual(await MemberAccount.count({ where: { normalizedPhone: '+905321234569' } }), 0);

  const studioG = await createStudio('Studio G', 'studio-g');
  const memberG = await createMember(studioG, 'G', '+905321234570');
  const adminG = await User.create({ username: 'admin-g', password: 'hash', role: 'admin', studioId: studioG.id });
  const expiredCode = await generateActivationCode({ studioId: studioG.id, memberId: memberG.id, createdByUserId: adminG.id });
  await MemberActivationCode.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { memberId: memberG.id } });
  await assert.rejects(() => activateMember({ phone: '+905321234570', code: expiredCode.code, password: 'member-password', passwordConfirmation: 'member-password' }));

  const studioH = await createStudio('Studio H', 'studio-h');
  const memberH = await createMember(studioH, 'H', '+905321234571');
  const adminH = await User.create({ username: 'admin-h', password: 'hash', role: 'admin', studioId: studioH.id });
  memberH.normalizedPhone = null;
  await memberH.save();
  await assert.rejects(() => generateActivationCode({ studioId: studioH.id, memberId: memberH.id, createdByUserId: adminH.id }));

  assert.strictEqual(await MemberAccount.count({ where: { normalizedPhone: '+905321234567' } }), 1);
  assert.strictEqual(await MemberAccountMembership.count({ where: { accountId: account.id } }), 4);
  console.log('member activation validation passed');
  await sequelize.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
