// Disposable validator (not part of product code): regression coverage for
// catalog LessonPackage price changes — existing assignments retain their
// persisted originalPrice/finalPrice/discounts, member debt/credit and payment
// history are untouched, new assignments snapshot the new price, deletion
// reverses the historical assigned price, and member detail / self-service /
// reports stay consistent — against an isolated temp SQLite DB. Does not touch
// the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-price-'));
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
  Payment,
  PaymentMethod,
} = require('../models');
const memberController = require('../controllers/memberController');
const paymentController = require('../controllers/paymentController');
const lessonPackageController = require('../controllers/lessonPackageController');
const reportsController = require('../controllers/reportsController');
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
  const payMethodA = await PaymentMethod.create({ name: 'Cash', studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  let phoneSeq = 0;
  async function makeMember(name, totalDebt = 0) {
    phoneSeq += 1;
    const phone = `+9054555${String(phoneSeq).padStart(5, '0')}`;
    return Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons: 0, totalDebt, isActive: true, studioId: studioA.id,
    });
  }

  async function debtOf(memberId) {
    return Number((await Member.findOne({ where: { id: memberId } })).totalDebt);
  }

  // Each case uses its own catalog package so price changes never leak between cases.
  async function makePackage(name, price) {
    return LessonPackage.create({ name, lessonCount: 10, price, studioId: studioA.id });
  }

  async function addPackage(memberId, packageId, body = {}) {
    const res = mockRes();
    await memberController.addLessonPackage(
      reqFor(asAdminA, { lessonPackageId: packageId, ...body }, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function assignmentOf(memberId) {
    return MemberLessonPackage.findOne({ where: { memberId }, order: [['id', 'DESC']] });
  }

  async function setCatalogPrice(packageId, newPrice) {
    const res = mockRes();
    await lessonPackageController.updateLessonPackage(
      reqFor(asAdminA, { price: newPrice }, { params: { id: packageId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(Number(res.body.price), newPrice);
  }

  async function memberDetailPrice(memberId) {
    const res = mockRes();
    await memberController.getMember(reqFor(asAdminA, {}, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.assignedLessonPackages[0];
  }

  async function selfServicePrice(memberId) {
    const result = await memberSelfService.getPackages({
      memberId, memberStudioId: studioA.id, memberAccount: null, query: {},
    });
    return result.packages[0];
  }

  async function reportsRevenue() {
    const res = mockRes();
    await reportsController.getReports(reqFor(asAdminA, {}, { query: { mode: 'daily' } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.summary;
  }

  // --- P1: price increase after a paid assignment -> nothing historical changes ---
  {
    const pkg = await makePackage('Pkg P1', 1000);
    const m = await makeMember('P1 Member');
    await addPackage(m.id, pkg.id); // +1000 debt, originalPrice/finalPrice 1000
    const pay = mockRes();
    await paymentController.createPayment(
      reqFor(asAdminA, { memberId: m.id, amount: 1000, paymentMethodId: payMethodA.id, date: '2026-11-03' }), pay);
    assert.strictEqual(pay.statusCode, 201, JSON.stringify(pay.body));
    assert.strictEqual(await debtOf(m.id), 0, 'paid off');

    const before = await assignmentOf(m.id);
    const beforeOriginal = Number(before.originalPrice);
    const beforeFinal = Number(before.finalPrice);

    await setCatalogPrice(pkg.id, 1500);

    const after = await assignmentOf(m.id);
    assert.strictEqual(Number(after.originalPrice), beforeOriginal, 'originalPrice unchanged');
    assert.strictEqual(Number(after.finalPrice), beforeFinal, 'finalPrice unchanged');
    assert.strictEqual(after.discountType, null, 'discountType unchanged');
    assert.strictEqual(await debtOf(m.id), 0, 'debt unchanged by catalog price increase');
    const payments = await Payment.findAll({ where: { memberId: m.id } });
    assert.strictEqual(payments.length, 1, 'payment history untouched');
    assert.strictEqual(Number(payments[0].amount), 1000, 'payment amount unchanged');

    const detail = await memberDetailPrice(m.id);
    assert.strictEqual(detail.price, 1000, 'member detail price = historical 1000');
    const self = await selfServicePrice(m.id);
    assert.strictEqual(self.price, 1000, 'self-service price = historical 1000');
    console.log('P1 OK: price increase after paid assignment -> history preserved');
  }

  // --- P2: price increase after a DISCOUNTED assignment -> discount + net price preserved ---
  {
    const pkg = await makePackage('Pkg P2', 1000);
    const m = await makeMember('P2 Member');
    await addPackage(m.id, pkg.id, { discountType: 'percent', discountValue: 20 }); // finalPrice 800
    assert.strictEqual(await debtOf(m.id), 800);

    await setCatalogPrice(pkg.id, 2000);

    const after = await assignmentOf(m.id);
    assert.strictEqual(Number(after.originalPrice), 1000, 'originalPrice still 1000');
    assert.strictEqual(Number(after.finalPrice), 800, 'finalPrice still 800');
    assert.strictEqual(after.discountType, 'percent', 'discountType preserved');
    assert.strictEqual(Number(after.discountValue), 20, 'discountValue preserved');
    assert.strictEqual(await debtOf(m.id), 800, 'debt unchanged');

    const detail = await memberDetailPrice(m.id);
    assert.strictEqual(detail.price, 800, 'member detail price = discounted 800');
    assert.strictEqual(detail.originalPrice, 1000);
    assert.strictEqual(detail.finalPrice, 800);
    const self = await selfServicePrice(m.id);
    assert.strictEqual(self.price, 800, 'self-service price = discounted 800');
    console.log('P2 OK: price increase after discounted assignment -> discount preserved');
  }

  // --- P3: NEW assignment after price increase uses the NEW price ---
  {
    const pkg = await makePackage('Pkg P3', 1000);
    await setCatalogPrice(pkg.id, 2000);
    const m = await makeMember('P3 Member');
    const assignment = await addPackage(m.id, pkg.id); // catalog now 2000
    assert.strictEqual(assignment.originalPrice, 2000, 'new assignment snapshots new catalog price');
    assert.strictEqual(assignment.finalPrice, 2000);
    assert.strictEqual(await debtOf(m.id), 2000, 'debt += new price');
    console.log('P3 OK: new assignment uses new catalog price');
  }

  // --- P4: deletion after price increase reverses the HISTORICAL assigned price ---
  {
    const pkg = await makePackage('Pkg P4', 1000);
    const m = await makeMember('P4 Member');
    await addPackage(m.id, pkg.id, { discountType: 'amount', discountValue: 300 }); // finalPrice 700
    assert.strictEqual(await debtOf(m.id), 700);
    await setCatalogPrice(pkg.id, 2500);

    const assignment = await assignmentOf(m.id);
    const res = mockRes();
    await memberController.deleteAssignedLessonPackage(
      reqFor(asAdminA, {}, { params: { memberId: m.id, assignedPackageId: assignment.id } }), res);
    assert.strictEqual(res.statusCode, 204, JSON.stringify(res.body));
    assert.strictEqual(await debtOf(m.id), 0, 'deletion reversed historical 700, not current 2500');
    console.log('P4 OK: deletion reverses historical assigned price after catalog increase');
  }

  // --- P5: reports revenue unchanged by catalog price increase ---
  {
    // Studio A currently has: P1 (finalPrice 1000), P2 (800), P3 (2000 new price).
    // P4's assignment was deleted.
    const summary = await reportsRevenue();
    const expected = 1000 + 800 + 2000;
    assert.strictEqual(summary.soldPackageRevenue, expected, `reports revenue uses persisted prices, got ${summary.soldPackageRevenue}`);
    console.log('P5 OK: reports revenue consistent after catalog price changes');
  }

  // --- P6: member credit survives a catalog price increase ---
  {
    const pkg = await makePackage('Pkg P6', 2000);
    const m = await makeMember('P6 Member');
    await addPackage(m.id, pkg.id); // +2000
    const pay = mockRes();
    await paymentController.createPayment(
      reqFor(asAdminA, { memberId: m.id, amount: 2500, paymentMethodId: payMethodA.id, date: '2026-11-03' }), pay);
    assert.strictEqual(pay.statusCode, 201);
    assert.strictEqual(await debtOf(m.id), -500, 'credit -500');

    await setCatalogPrice(pkg.id, 3000);
    assert.strictEqual(await debtOf(m.id), -500, 'credit unchanged by catalog price increase');
    const after = await assignmentOf(m.id);
    assert.strictEqual(Number(after.finalPrice), 2000, 'assignment finalPrice unchanged');
    console.log('P6 OK: member credit survives catalog price increase');
  }

  console.log('All catalog-price-change cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
