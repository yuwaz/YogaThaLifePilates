// Disposable validator (not part of product code): proves the fee-only
// PATCH /settings/users/:id/fees controller is strictly scoped to
// groupSessionFee/individualSessionFee for instructor-capable Users only,
// against an isolated temp SQLite DB. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-endpoint-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const { sequelize, Studio, User } = require('../models');
  const userController = require('../controllers/userController');

  await sequelize.sync({ force: true });

  function mockRes() {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
    return res;
  }

  const studioA = await Studio.create({
    name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const ownerA = await User.create({
    username: 'ownerA', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    groupSessionFee: 0, individualSessionFee: 0, studioId: studioA.id,
  });
  studioA.ownerUserId = ownerA.id;
  await studioA.save();

  const instructorA = await User.create({
    username: 'instructorA', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: [],
    groupSessionFee: 0, individualSessionFee: 0, studioId: studioA.id,
  });
  const laterAdminA = await User.create({
    username: 'laterAdminA', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    studioId: studioA.id,
  });

  const studioB = await Studio.create({
    name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const ownerB = await User.create({
    username: 'ownerB', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    studioId: studioB.id,
  });
  studioB.ownerUserId = ownerB.id;
  await studioB.save();

  function patchFeesReq(actingUser, targetId, body) {
    return {
      user: { id: actingUser.id, studioId: actingUser.studioId, role: actingUser.role },
      params: { id: String(targetId) },
      body,
    };
  }

  // Case A: owner accepted
  {
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, ownerA.id, { groupSessionFee: 111, individualSessionFee: 222 }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(Number(res.body.groupSessionFee), 111);
    assert.strictEqual(Number(res.body.individualSessionFee), 222);
    assert.strictEqual(res.body.role, 'admin');
    console.log('Case A OK: owner fee update accepted, role remains admin');
  }

  // Case B: normal instructor accepted
  {
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, instructorA.id, { groupSessionFee: 50, individualSessionFee: 75 }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(Number(res.body.groupSessionFee), 50);
    assert.strictEqual(Number(res.body.individualSessionFee), 75);
    assert.strictEqual(res.body.role, 'instructor');
    console.log('Case B OK: instructor fee update accepted, role remains instructor');
  }

  // Case C: later admin rejected
  {
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, laterAdminA.id, { groupSessionFee: 10, individualSessionFee: 10 }), res);
    assert.strictEqual(res.statusCode, 404);
    const stillZero = await User.findByPk(laterAdminA.id);
    assert.strictEqual(Number(stillZero.groupSessionFee), 0);
    console.log('Case C OK: later admin rejected (404), not mutated');
  }

  // Case D: cross-studio user rejected
  {
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, ownerB.id, { groupSessionFee: 10, individualSessionFee: 10 }), res);
    assert.strictEqual(res.statusCode, 404);
    console.log('Case D OK: cross-studio user rejected (404)');
  }

  // Case E: unknown user -> safe 404
  {
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, 999999, { groupSessionFee: 10, individualSessionFee: 10 }), res);
    assert.strictEqual(res.statusCode, 404);
    console.log('Case E OK: unknown user -> safe 404');
  }

  // Case F: invalid fee input -> safe 400, no mutation
  {
    const before = await User.findByPk(instructorA.id);
    const res = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, instructorA.id, { groupSessionFee: 'abc', individualSessionFee: 10 }), res);
    assert.strictEqual(res.statusCode, 400);
    const after = await User.findByPk(instructorA.id);
    assert.strictEqual(Number(after.groupSessionFee), Number(before.groupSessionFee));

    const res2 = mockRes();
    await userController.updateUserFees(patchFeesReq(ownerA, instructorA.id, { groupSessionFee: -5, individualSessionFee: 10 }), res2);
    assert.strictEqual(res2.statusCode, 400);
    console.log('Case F OK: invalid/negative fee input rejected safely, no mutation');
  }

  // Case G: extra role field must not mutate role
  {
    const res = mockRes();
    await userController.updateUserFees(
      patchFeesReq(ownerA, instructorA.id, { groupSessionFee: 60, individualSessionFee: 80, role: 'admin', username: 'hacked', password: 'x', permissions: ['settings'], assignedSalonIds: [999], studioId: 999 }),
      res
    );
    assert.strictEqual(res.statusCode, 200);
    const reloaded = await User.findByPk(instructorA.id);
    assert.strictEqual(reloaded.role, 'instructor');
    assert.strictEqual(reloaded.username, 'instructorA');
    assert.strictEqual(reloaded.studioId, studioA.id);
    assert.deepStrictEqual(reloaded.assignedSalonIds, [1]);
    assert.strictEqual(Number(reloaded.groupSessionFee), 60);
    assert.strictEqual(Number(reloaded.individualSessionFee), 80);
    console.log('Case G OK: extra fields ignored, only fees mutated');
  }

  // Case H: existing generic updateUser unchanged (owner role mutation still rejected there too)
  {
    const res = mockRes();
    await userController.updateUser(patchFeesReq(ownerA, ownerA.id, { role: 'instructor' }), res);
    assert.strictEqual(res.statusCode, 400);
    const stillAdmin = await User.findByPk(ownerA.id);
    assert.strictEqual(stillAdmin.role, 'admin');
    console.log('Case H OK: existing updateUser owner-protection behavior unchanged');
  }

  // Case I: existing instructor password-reset endpoint unchanged (still instructor-only, still works)
  {
    const res = mockRes();
    await userController.resetInstructorPassword(patchFeesReq(ownerA, instructorA.id, { newPassword: 'newpassword123' }), res);
    assert.strictEqual(res.statusCode, 200);
    console.log('Case I OK: existing instructor password-reset endpoint still works unchanged');
  }

  await sequelize.close();
  console.log('All fee-endpoint validation cases passed.');
}

run().catch((err) => {
  console.error('VALIDATION FAILED:', err);
  process.exit(1);
});
