// Disposable validator (not part of product code): regression coverage for
// package assignment/deletion pricing — deletion reverses the persisted
// assignment finalPrice (never the current catalog price), fixed/percent/100%
// discounts, changed catalog prices, unrelated debt preservation, missing
// catalog rows, legacy rows without persisted prices, and the assigned net
// price exposed via the `price` field in member detail + member self-service —
// against an isolated temp SQLite DB. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-pricing-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  Salon,
  MemberType,
  Member,
  LessonPackage,
  MemberLessonPackage,
} = require('../models');
const memberController = require('../controllers/memberController');
const memberSelfService = require('../services/memberSelfService');

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

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const pkg10 = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  let phoneSeq = 0;
  async function makeMember(name, totalDebt = 0, remainingLessons = 0) {
    phoneSeq += 1;
    const phone = `+9054333${String(phoneSeq).padStart(5, '0')}`;
    return Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons, totalDebt, isActive: true, studioId: studioA.id,
    });
  }

  async function addPackage(memberId, body = {}) {
    const res = mockRes();
    await memberController.addLessonPackage(
      reqFor(asAdminA, { lessonPackageId: pkg10.id, ...body }, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function deletePackage(memberId, assignedPackageId) {
    const res = mockRes();
    await memberController.deleteAssignedLessonPackage(
      reqFor(asAdminA, {}, { params: { memberId, assignedPackageId } }), res);
    assert.strictEqual(res.statusCode, 204, JSON.stringify(res.body));
  }

  async function debtOf(memberId) {
    const m = await Member.findOne({ where: { id: memberId } });
    return Number(m.totalDebt);
  }
  async function lessonsOf(memberId) {
    const m = await Member.findOne({ where: { id: memberId } });
    return Number(m.remainingLessons);
  }

  // --- F1: fixed-amount discount -> delete reverses finalPrice, not catalog price ---
  {
    const member = await makeMember('F1 Member');
    const assignment = await addPackage(member.id, { discountType: 'amount', discountValue: 200 });
    assert.strictEqual(assignment.finalPrice, 800);
    assert.strictEqual(await debtOf(member.id), 800, 'debt += finalPrice (800)');
    assert.strictEqual(await lessonsOf(member.id), 10);

    await deletePackage(member.id, (await MemberLessonPackage.findOne({ where: { memberId: member.id } })).id);
    assert.strictEqual(await debtOf(member.id), 0, 'debt reversed by finalPrice (800), not catalog (1000)');
    assert.strictEqual(await lessonsOf(member.id), 0, 'lessons reversed');
    console.log('F1 OK: fixed-amount discount deletion reverses finalPrice');
  }

  // --- F2: percentage discount -> delete reverses finalPrice ---
  {
    const member = await makeMember('F2 Member');
    await addPackage(member.id, { discountType: 'percent', discountValue: 25 });
    assert.strictEqual(await debtOf(member.id), 750, 'debt += 75% of 1000');

    await deletePackage(member.id, (await MemberLessonPackage.findOne({ where: { memberId: member.id } })).id);
    assert.strictEqual(await debtOf(member.id), 0, 'debt reversed by 750, not 1000');
    console.log('F2 OK: percentage discount deletion reverses finalPrice');
  }

  // --- F3: 100% discount (free package) -> delete reverses 0, debt untouched ---
  {
    const member = await makeMember('F3 Member', 500, 0); // pre-existing unrelated debt
    await addPackage(member.id, { discountType: 'percent', discountValue: 100 });
    assert.strictEqual(await debtOf(member.id), 500, 'free package adds no debt');
    assert.strictEqual(await lessonsOf(member.id), 10);

    await deletePackage(member.id, (await MemberLessonPackage.findOne({ where: { memberId: member.id } })).id);
    assert.strictEqual(await debtOf(member.id), 500, 'unrelated debt preserved exactly (no clamp erosion)');
    assert.strictEqual(await lessonsOf(member.id), 0);
    console.log('F3 OK: 100% discount deletion preserves unrelated debt');
  }

  // --- F4: catalog price changed after assignment -> delete reverses historical finalPrice ---
  {
    const member = await makeMember('F4 Member');
    await addPackage(member.id); // no discount: finalPrice = 1000
    assert.strictEqual(await debtOf(member.id), 1000);

    // Catalog price rises to 1500 after assignment.
    await pkg10.update({ price: 1500 });
    await deletePackage(member.id, (await MemberLessonPackage.findOne({ where: { memberId: member.id } })).id);
    assert.strictEqual(await debtOf(member.id), 0, 'reversed historical 1000, not new catalog 1500');
    await pkg10.update({ price: 1000 }); // restore for other cases
    console.log('F4 OK: changed catalog price -> deletion reverses historical finalPrice');
  }

  // --- F5: unrelated debt from another package is preserved on deletion ---
  {
    const member = await makeMember('F5 Member');
    await addPackage(member.id); // 1000 debt, 10 lessons
    const second = await addPackage(member.id, { discountType: 'amount', discountValue: 400 }); // +600, +10 lessons
    assert.strictEqual(await debtOf(member.id), 1600);
    assert.strictEqual(await lessonsOf(member.id), 20);

    // Delete only the discounted assignment.
    const discounted = await MemberLessonPackage.findOne({ where: { memberId: member.id, finalPrice: 600 } });
    await deletePackage(member.id, discounted.id);
    assert.strictEqual(await debtOf(member.id), 1000, 'first package debt intact');
    assert.strictEqual(await lessonsOf(member.id), 10, 'first package lessons intact');
    console.log('F5 OK: unrelated package debt/lessons preserved');
  }

  // --- F6: missing catalog row -> debt still reversed from persisted finalPrice ---
  {
    const member = await makeMember('F6 Member');
    // Dedicated catalog package (destroyed below; must not affect other cases).
    const pkgF6 = await LessonPackage.create({ name: 'Pkg F6', lessonCount: 10, price: 1000, studioId: studioA.id });
    const res = mockRes();
    await memberController.addLessonPackage(
      reqFor(asAdminA, { lessonPackageId: pkgF6.id, discountType: 'amount', discountValue: 300 }, { params: { id: member.id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(await debtOf(member.id), 700);
    assert.strictEqual(await lessonsOf(member.id), 10);

    const assignment = await MemberLessonPackage.findOne({ where: { memberId: member.id } });
    // Simulate a deleted catalog row (FK enforcement off for this simulation).
    await sequelize.query('PRAGMA foreign_keys = OFF');
    await LessonPackage.destroy({ where: { id: assignment.lessonPackageId, studioId: studioA.id } });
    await sequelize.query('PRAGMA foreign_keys = ON');

    await deletePackage(member.id, assignment.id);
    assert.strictEqual(await debtOf(member.id), 0, 'debt reversed from persisted finalPrice despite missing catalog row');
    assert.strictEqual(await lessonsOf(member.id), 10, 'lessons NOT reversed (no persisted lessonCount) — no guessed amounts');
    console.log('F6 OK: missing catalog row -> debt reversed from finalPrice, lessons untouched');
  }

  // --- F7: legacy row (finalPrice NULL is impossible under the current NOT NULL
  // schema; the closest real legacy shape is a dangling lessonPackageId whose
  // catalog row was deleted) -> deletion reverses persisted finalPrice, never
  // guesses amounts ---
  {
    const member = await makeMember('F7 Member', 900, 5);
    // Legacy-style assignment: persisted prices, dangling catalog reference
    // (FK enforcement off for this simulation).
    await sequelize.query('PRAGMA foreign_keys = OFF');
    const [, insertMeta] = await sequelize.query(
      `INSERT INTO MemberLessonPackages (memberId, lessonPackageId, assignedAt, originalPrice, discountType, discountValue, finalPrice, studioId, createdAt, updatedAt)
       VALUES (?, -1, datetime('now'), 900, NULL, NULL, 900, ?, datetime('now'), datetime('now'))`,
      { replacements: [member.id, studioA.id] }
    );
    await sequelize.query('PRAGMA foreign_keys = ON');
    const legacyAssignmentId = insertMeta.lastID;

    await deletePackage(member.id, legacyAssignmentId);
    assert.strictEqual(await debtOf(member.id), 0, 'legacy row reversed via persisted finalPrice');
    assert.strictEqual(await lessonsOf(member.id), 5, 'lessons untouched (no catalog row, no persisted count)');
    console.log('F7 OK: legacy row (dangling catalog ref) -> persisted price, no guessed amounts');
  }

  // --- F8: member detail exposes assigned net price via `price` field ---
  {
    const member = await makeMember('F8 Member');
    await addPackage(member.id, { discountType: 'percent', discountValue: 30 }); // finalPrice 700
    const res = mockRes();
    await memberController.getMember(reqFor(asAdminA, {}, { params: { id: member.id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const pkg = res.body.assignedLessonPackages[0];
    assert.strictEqual(pkg.price, 700, 'price = assigned net price (finalPrice)');
    assert.strictEqual(pkg.originalPrice, 1000, 'originalPrice preserved');
    assert.strictEqual(pkg.finalPrice, 700, 'finalPrice preserved');
    assert.strictEqual(pkg.discountType, 'percent', 'discountType preserved');
    assert.strictEqual(pkg.discountValue, 30, 'discountValue preserved');
    assert.ok('name' in pkg && 'lessonCount' in pkg && 'assignedAt' in pkg && 'id' in pkg, 'response shape preserved');
    console.log('F8 OK: member detail price = assigned net price, shape preserved');
  }

  // --- F9: member self-service packagePayload exposes assigned net price ---
  {
    const member = await makeMember('F9 Member');
    await addPackage(member.id, { discountType: 'amount', discountValue: 250 }); // finalPrice 750
    const result = await memberSelfService.getPackages({
      memberId: member.id,
      memberStudioId: studioA.id,
      memberAccount: null,
      query: {},
    });
    const pkg = result.packages[0];
    assert.strictEqual(pkg.price, 750, 'self-service price = assigned net price');
    assert.strictEqual(pkg.originalPrice, 1000);
    assert.strictEqual(pkg.finalPrice, 750);
    assert.ok('assignmentId' in pkg && 'packageId' in pkg && 'assignedAt' in pkg, 'response shape preserved');
    console.log('F9 OK: member self-service price = assigned net price, shape preserved');
  }

  console.log('All package-deletion-pricing cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
