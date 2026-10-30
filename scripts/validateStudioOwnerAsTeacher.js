// Disposable validator (not part of product code): proves Studio owner identity +
// owner-as-teacher support end to end, against an isolated temp SQLite DB. Does not
// touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-teacher-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const { sequelize, Studio, User, MemberType, Salon } = require('../models');
  const ensureStudiosTable = require('../ensureStudiosTable');
  const userController = require('../controllers/userController');
  const memberController = require('../controllers/memberController');
  const { getStudioOwnerUserId } = require('../services/studioOwnerService');

  await sequelize.sync({ force: true });
  // Exercises the idempotent ensure-script path against an already-created table too.
  await ensureStudiosTable();

  function mockRes() {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
    return res;
  }

  // --- Case A: new-registration-style owner persistence (direct model use, same as registerController) ---
  const studioA = await Studio.create({
    name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const ownerA = await User.create({
    username: 'ownerA', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    groupSessionFee: 100, individualSessionFee: 200, studioId: studioA.id,
  });
  studioA.ownerUserId = ownerA.id;
  await studioA.save();

  assert.strictEqual(await getStudioOwnerUserId(studioA.id), ownerA.id);
  assert.strictEqual(ownerA.role, 'admin');
  console.log('Case A OK: owner persisted, role remains admin');

  // --- Case B: existing (legacy) Studio must NOT be auto-backfilled ---
  const legacyStudio = await Studio.create({
    name: 'Legacy Studio', studioCode: 'legacy-studio', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  await User.create({
    username: 'legacyAdmin', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    studioId: legacyStudio.id,
  });
  assert.strictEqual(await getStudioOwnerUserId(legacyStudio.id), null);
  console.log('Case B OK: legacy studio stays ownerUserId=null, no guessed backfill');

  // --- Case C: owner + instructor + later admin -> instructor-capable list ---
  const instructorA = await User.create({
    username: 'instructorA', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: [],
    studioId: studioA.id,
  });
  const laterAdminA = await User.create({
    username: 'laterAdminA', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    studioId: studioA.id,
  });

  const reqGetInstructors = { user: { id: ownerA.id, studioId: studioA.id, role: 'admin' } };
  const resGetInstructors = mockRes();
  await userController.getInstructors(reqGetInstructors, resGetInstructors);
  const listIds = resGetInstructors.body.map((u) => u.id);
  assert.ok(listIds.includes(ownerA.id), 'owner should be included');
  assert.ok(listIds.includes(instructorA.id), 'instructor should be included');
  assert.ok(!listIds.includes(laterAdminA.id), 'later admin must be excluded');
  const ownerRow = resGetInstructors.body.find((u) => u.id === ownerA.id);
  assert.strictEqual(ownerRow.role, 'admin', 'owner role must not be misreported as instructor');
  console.log('Case C OK: instructor-capable list = [owner, instructor], later admin excluded, owner role truthful');

  // --- Case D: cross-studio isolation ---
  const studioB = await Studio.create({
    name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const ownerB = await User.create({
    username: 'ownerB', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    studioId: studioB.id,
  });
  studioB.ownerUserId = ownerB.id;
  await studioB.save();

  const reqGetInstructorsB = { user: { id: ownerB.id, studioId: studioB.id, role: 'admin' } };
  const resGetInstructorsB = mockRes();
  await userController.getInstructors(reqGetInstructorsB, resGetInstructorsB);
  const listIdsB = resGetInstructorsB.body.map((u) => u.id);
  assert.ok(!listIdsB.includes(ownerA.id) && !listIdsB.includes(instructorA.id), 'Studio A owner/instructor must never appear in Studio B');
  console.log('Case D OK: cross-studio isolation preserved');

  // --- Case E: Member assignedInstructorId validation (owner accepted, later admin rejected, cross-studio rejected) ---
  const salonA = await require('../models').Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Standard', color: '#123456', studioId: studioA.id });

  async function tryCreateMember(instructorId) {
    const req = {
      user: { id: ownerA.id, studioId: studioA.id, role: 'admin' },
      body: {
        name: `Member ${instructorId}-${Math.random()}`,
        phone: `+9055512${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
        memberTypeId: memberTypeA.id,
        assignedSalonIds: [salonA.id],
        assignedInstructorId: instructorId,
      },
    };
    const res = mockRes();
    await memberController.createMember(req, res);
    return res;
  }

  const ownerAcceptedRes = await tryCreateMember(ownerA.id);
  assert.strictEqual(ownerAcceptedRes.statusCode, 201);
  assert.strictEqual(ownerAcceptedRes.body.assignedInstructorId, ownerA.id);

  const instructorAcceptedRes = await tryCreateMember(instructorA.id);
  assert.strictEqual(instructorAcceptedRes.statusCode, 201);
  assert.strictEqual(instructorAcceptedRes.body.assignedInstructorId, instructorA.id);

  const laterAdminRes = await tryCreateMember(laterAdminA.id);
  assert.strictEqual(laterAdminRes.statusCode, 404, 'later admin must be rejected as assignedInstructorId');

  const crossStudioRes = await tryCreateMember(ownerB.id);
  assert.strictEqual(crossStudioRes.statusCode, 404, 'cross-studio user must be rejected as assignedInstructorId');
  console.log('Case E OK: owner accepted, instructor accepted, later admin rejected, cross-studio rejected');

  // --- Case F: owner delete rejected ---
  const reqDeleteOwner = { user: { id: ownerA.id, studioId: studioA.id, role: 'admin' }, params: { id: String(ownerA.id) } };
  const resDeleteOwner = mockRes();
  await userController.deleteUser(reqDeleteOwner, resDeleteOwner);
  assert.strictEqual(resDeleteOwner.statusCode, 400);
  const stillExists = await User.findByPk(ownerA.id);
  assert.ok(stillExists, 'owner must not be deleted');
  console.log('Case F OK: owner delete rejected safely');

  // --- Case G: owner role mutation/demotion rejected ---
  const reqDemoteOwner = {
    user: { id: ownerA.id, studioId: studioA.id, role: 'admin' },
    params: { id: String(ownerA.id) },
    body: { role: 'instructor' },
  };
  const resDemoteOwner = mockRes();
  await userController.updateUser(reqDemoteOwner, resDemoteOwner);
  assert.strictEqual(resDemoteOwner.statusCode, 400);
  const notDemoted = await User.findByPk(ownerA.id);
  assert.strictEqual(notDemoted.role, 'admin', 'owner role must remain admin');
  console.log('Case G OK: owner role mutation/demotion rejected safely');

  // --- Case H: owner non-role update allowed (username) ---
  const reqRenameOwner = {
    user: { id: ownerA.id, studioId: studioA.id, role: 'admin' },
    params: { id: String(ownerA.id) },
    body: { username: 'ownerA-renamed' },
  };
  const resRenameOwner = mockRes();
  await userController.updateUser(reqRenameOwner, resRenameOwner);
  assert.strictEqual(resRenameOwner.statusCode, 200);
  assert.strictEqual(resRenameOwner.body.username, 'ownerA-renamed');
  console.log('Case H OK: owner non-role update (username) still allowed');

  // --- Case I: owner fee updates supported without role change ---
  const reqFeeOwner = {
    user: { id: ownerA.id, studioId: studioA.id, role: 'admin' },
    params: { id: String(ownerA.id) },
    body: { groupSessionFee: 150, individualSessionFee: 250 },
  };
  const resFeeOwner = mockRes();
  await userController.updateUser(reqFeeOwner, resFeeOwner);
  assert.strictEqual(resFeeOwner.statusCode, 200);
  assert.strictEqual(Number(resFeeOwner.body.groupSessionFee), 150);
  assert.strictEqual(Number(resFeeOwner.body.individualSessionFee), 250);
  assert.strictEqual(resFeeOwner.body.role, 'admin');
  console.log('Case I/that owner fee fields updatable without role change: OK');

  // --- Case L: normal instructor delete/update still works unaffected ---
  const reqDeleteInstructor = { user: { id: ownerA.id, studioId: studioA.id, role: 'admin' }, params: { id: String(instructorA.id) } };
  const resDeleteInstructor = mockRes();
  await userController.deleteUser(reqDeleteInstructor, resDeleteInstructor);
  assert.strictEqual(resDeleteInstructor.statusCode, 204);
  const instructorGone = await User.findByPk(instructorA.id);
  assert.ok(!instructorGone, 'normal instructor deletion must remain unaffected');
  console.log('Case L OK: normal instructor delete behavior unchanged');

  await sequelize.close();
  console.log('All owner-as-teacher validation cases passed.');
}

run().catch((err) => {
  console.error('VALIDATION FAILED:', err);
  process.exit(1);
});
