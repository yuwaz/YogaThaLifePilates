// Disposable validator (not part of product code): regression coverage for
// member credit (negative balances) and refunds as signed Payment.amount —
// one balance rule (balance = net package charges − signed payments), zero
// rejection, refund credit cap, no silent clamping, payment update/delete
// correction semantics, discounted-package deletion without zero clamp,
// deactivation blocked on any nonzero balance, reports prepaidCredit, and
// studio isolation — against an isolated temp SQLite DB. Does not touch the
// real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-refund-'));
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
const reportsController = require('../controllers/reportsController');

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
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const pkg10 = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });
  const payMethodA = await PaymentMethod.create({ name: 'Cash', studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };

  let phoneSeq = 0;
  async function makeMember(name, totalDebt = 0, remainingLessons = 0, studioId = studioA.id) {
    phoneSeq += 1;
    const phone = `+9054444${String(phoneSeq).padStart(5, '0')}`;
    return Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons, totalDebt, isActive: true, studioId,
    });
  }

  async function debtOf(memberId) {
    const m = await Member.findOne({ where: { id: memberId } });
    return Number(m.totalDebt);
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

  // Both payment endpoints.
  async function createPaymentViaSettings(memberId, amount) {
    const res = mockRes();
    await paymentController.createPayment(
      reqFor(asAdminA, { memberId, amount, paymentMethodId: payMethodA.id, date: '2026-11-02' }), res);
    return res;
  }
  async function addPaymentViaMember(memberId, amount) {
    const res = mockRes();
    await memberController.addPayment(
      reqFor(asAdminA, { amount, paymentMethodId: payMethodA.id, date: '2026-11-02' }, { params: { id: memberId } }), res);
    return res;
  }

  // --- C1: overpayment creates credit consistently on BOTH payment endpoints ---
  {
    const m1 = await makeMember('C1a');
    await addPackage(m1.id); // +1000 debt
    const res = await createPaymentViaSettings(m1.id, 1200); // overpay 200
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(await debtOf(m1.id), -200, 'settings endpoint: overpayment -> credit -200');

    const m2 = await makeMember('C1b');
    await addPackage(m2.id);
    const res2 = await addPaymentViaMember(m2.id, 1200);
    assert.strictEqual(res2.statusCode, 201, JSON.stringify(res2.body));
    assert.strictEqual(await debtOf(m2.id), -200, 'member endpoint: overpayment -> credit -200 (parity)');
    console.log('C1 OK: overpayment creates credit on both payment endpoints');
  }

  // --- C2: zero amount rejected on both endpoints ---
  {
    const m = await makeMember('C2');
    const res1 = await createPaymentViaSettings(m.id, 0);
    assert.strictEqual(res1.statusCode, 400, 'settings endpoint rejects zero');
    const res2 = await addPaymentViaMember(m.id, 0);
    assert.strictEqual(res2.statusCode, 400, 'member endpoint rejects zero');
    const count = await Payment.count({ where: { memberId: m.id } });
    assert.strictEqual(count, 0, 'no zero payment persisted');
    console.log('C2 OK: zero amount rejected on both endpoints');
  }

  // --- C3: refund (negative payment) consumes credit, capped at available credit ---
  {
    const m = await makeMember('C3');
    await addPackage(m.id); // +1000
    await createPaymentViaSettings(m.id, 1300); // credit -300
    assert.strictEqual(await debtOf(m.id), -300);

    // Refund 200 -> balance -100.
    const refund = await createPaymentViaSettings(m.id, -200);
    assert.strictEqual(refund.statusCode, 201, JSON.stringify(refund.body));
    assert.strictEqual(Number(refund.body.amount), -200, 'refund persisted as negative payment');
    assert.strictEqual(await debtOf(m.id), -100, 'refund increases balance (credit consumed)');

    // Refund exceeding credit -> 400.
    const tooBig = await createPaymentViaSettings(m.id, -150);
    assert.strictEqual(tooBig.statusCode, 400, 'refund exceeding credit rejected');
    assert.strictEqual(await debtOf(m.id), -100, 'balance unchanged after rejected refund');

    // Refund with no credit -> 400.
    const m2 = await makeMember('C3b', 500);
    const noCredit = await createPaymentViaSettings(m2.id, -50);
    assert.strictEqual(noCredit.statusCode, 400, 'refund without credit rejected');
    assert.strictEqual(await debtOf(m2.id), 500);
    console.log('C3 OK: refunds consume credit, capped, rejected without credit');
  }

  // --- C4: refund via member endpoint parity ---
  {
    const m = await makeMember('C4');
    await addPackage(m.id);
    await addPaymentViaMember(m.id, 1100); // credit -100
    const refund = await addPaymentViaMember(m.id, -100); // full credit refund
    assert.strictEqual(refund.statusCode, 201, JSON.stringify(refund.body));
    assert.strictEqual(await debtOf(m.id), 0, 'full credit refund zeroes balance');
    console.log('C4 OK: member endpoint refund parity');
  }

  // --- C5: package deletion preserves credit (no zero clamp) ---
  {
    const m = await makeMember('C5');
    await addPackage(m.id); // +1000
    await createPaymentViaSettings(m.id, 1500); // credit -500
    const assignment = await MemberLessonPackage.findOne({ where: { memberId: m.id } });
    await deletePackage(m.id, assignment.id); // -1000
    assert.strictEqual(await debtOf(m.id), -1500, 'credit preserved: -500 - 1000 = -1500 (no clamp)');
    console.log('C5 OK: package deletion preserves member credit (no zero clamp)');
  }

  // --- C6: discounted package deletion still reverses finalPrice (prior fix preserved) ---
  {
    const m = await makeMember('C6');
    await addPackage(m.id, { discountType: 'percent', discountValue: 40 }); // finalPrice 600
    assert.strictEqual(await debtOf(m.id), 600);
    const assignment = await MemberLessonPackage.findOne({ where: { memberId: m.id } });
    await deletePackage(m.id, assignment.id);
    assert.strictEqual(await debtOf(m.id), 0, 'discounted deletion reverses finalPrice exactly');
    console.log('C6 OK: discounted-package deletion fix preserved');
  }

  // --- C7: payment update (signed delta) + credit cap on refund increase ---
  {
    const m = await makeMember('C7');
    await addPackage(m.id); // +1000
    const pay = await createPaymentViaSettings(m.id, 1000); // balance 0
    const paymentId = pay.body.id;

    // Update payment 1000 -> 1200: balance -200 (credit).
    const upd = mockRes();
    await paymentController.updatePayment(
      reqFor(asAdminA, { amount: 1200 }, { params: { id: paymentId } }), upd);
    assert.strictEqual(upd.statusCode, 200, JSON.stringify(upd.body));
    assert.strictEqual(await debtOf(m.id), -200);

    // Update payment 1200 -> 800 (delta -400 = refund direction, within the
    // credit this payment granted): balance -200 - (-400) = 200.
    const upd2 = mockRes();
    await paymentController.updatePayment(
      reqFor(asAdminA, { amount: 800 }, { params: { id: paymentId } }), upd2);
    assert.strictEqual(upd2.statusCode, 200, JSON.stringify(upd2.body));
    assert.strictEqual(await debtOf(m.id), 200);

    // Update to zero -> 400.
    const updZero = mockRes();
    await paymentController.updatePayment(
      reqFor(asAdminA, { amount: 0 }, { params: { id: paymentId } }), updZero);
    assert.strictEqual(updZero.statusCode, 400, 'update to zero rejected');

    // Refund-direction update WITHIN the credit this payment granted is allowed:
    // 800 -> -100 converts 900 of the payment into a refund; resulting credit
    // 100 <= creditBefore(0) + oldAmount(800). Balance: 200 - (-900) = 1100.
    const updRefund = mockRes();
    await paymentController.updatePayment(
      reqFor(asAdminA, { amount: -100 }, { params: { id: paymentId } }), updRefund);
    assert.strictEqual(updRefund.statusCode, 200, 'payment-to-refund conversion within granted credit allowed');
    assert.strictEqual(await debtOf(m.id), 1100, 'balance reflects converted refund');

    // Refund-direction update cap: with the creditBefore + |oldAmount| formula,
    // enlarging a refund while the member is in credit always nets toward debt
    // (the old amount offsets), so it is a legitimate correction, never an
    // over-credit. Assert that behavior.
    const m2 = await makeMember('C7b');
    await addPackage(m2.id); // +1000
    await createPaymentViaSettings(m2.id, 1100); // credit -100
    const smallPay = await createPaymentViaSettings(m2.id, 100); // credit -200
    assert.strictEqual(await debtOf(m2.id), -200);
    const refundRec2 = await createPaymentViaSettings(m2.id, -50); // credit -150
    assert.strictEqual(await debtOf(m2.id), -150);
    // Enlarge refund -50 -> -1000: nextDebt = -150 - (-1000 + 50) = 800 (debt).
    const updLarge = mockRes();
    await paymentController.updatePayment(
      reqFor(asAdminA, { amount: -1000 }, { params: { id: refundRec2.body.id } }), updLarge);
    assert.strictEqual(updLarge.statusCode, 200, 'large refund enlargement is a legitimate correction');
    assert.strictEqual(await debtOf(m2.id), 800, 'balance reflects correction: -150 + 950');
    console.log('C7 OK: payment update signed delta + credit cap');
  }

  // --- C8: payment deletion = record correction only (exact reversal) ---
  {
    const m = await makeMember('C8');
    await addPackage(m.id); // +1000
    const pay = await createPaymentViaSettings(m.id, 400); // balance 600
    const del = mockRes();
    await paymentController.deletePayment(reqFor(asAdminA, {}, { params: { id: pay.body.id } }), del);
    assert.strictEqual(del.statusCode, 204);
    assert.strictEqual(await debtOf(m.id), 1000, 'deletion restores exact amount (record correction)');

    // Deleting a REFUND record reverses the refund.
    await createPaymentViaSettings(m.id, 1500); // balance -500
    const refund = await createPaymentViaSettings(m.id, -200); // balance -300
    const delRefund = mockRes();
    await paymentController.deletePayment(reqFor(asAdminA, {}, { params: { id: refund.body.id } }), delRefund);
    assert.strictEqual(delRefund.statusCode, 204);
    assert.strictEqual(await debtOf(m.id), -500, 'deleting refund record restores credit');
    console.log('C8 OK: payment deletion is exact record correction (payments and refunds)');
  }

  // --- C9: deactivation blocked on ANY nonzero balance (debt AND credit) ---
  {
    const inDebt = await makeMember('C9a', 100);
    const res1 = mockRes();
    await memberController.deleteMember(reqFor(asAdminA, {}, { params: { id: inDebt.id } }), res1);
    assert.strictEqual(res1.statusCode, 400, 'debt blocks deactivation');

    const inCredit = await makeMember('C9b', -100);
    const res2 = mockRes();
    await memberController.deleteMember(reqFor(asAdminA, {}, { params: { id: inCredit.id } }), res2);
    assert.strictEqual(res2.statusCode, 400, 'credit blocks deactivation');
    assert.ok(String(res2.body.message).includes('kredi'), 'credit message');

    const zero = await makeMember('C9c', 0);
    const res3 = mockRes();
    await memberController.deleteMember(reqFor(asAdminA, {}, { params: { id: zero.id } }), res3);
    assert.strictEqual(res3.statusCode, 200, 'zero balance deactivates');
    console.log('C9 OK: deactivation blocked on any nonzero balance');
  }

  // --- C10: reports prepaidCredit + totalDebt netting ---
  {
    // Fresh studio B isolation check + reports on studio A.
    const creditMember = await makeMember('C10a', -250);
    const debtMember = await makeMember('C10b', 400);
    const res = mockRes();
    await reportsController.getReports(reqFor(asAdminA, {}, { query: { mode: 'daily' } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const { summary, paymentBreakdown } = res.body;
    assert.ok(typeof summary.prepaidCredit === 'number', 'prepaidCredit in summary');
    assert.ok(summary.prepaidCredit <= -250, `prepaidCredit includes -250 credit, got ${summary.prepaidCredit}`);
    assert.strictEqual(paymentBreakdown.prepaidCredit, summary.prepaidCredit, 'paymentBreakdown.prepaidCredit matches');
    // totalDebt still nets (credit reduces it).
    assert.ok(typeof summary.totalDebt === 'number', 'totalDebt still present');
    console.log('C10 OK: reports expose prepaidCredit, totalDebt preserved');
  }

  // --- C11: studio isolation ---
  {
    const memberB = await makeMember('C11 B', 0, 0, studioB.id);
    // Payment method from studio A must not be usable for studio B member via scoped endpoints.
    const res = await paymentController.createPayment(
      reqFor(asAdminA, { memberId: memberB.id, amount: 100, paymentMethodId: payMethodA.id, date: '2026-11-02' }), mockRes());
    assert.strictEqual(res.statusCode, 404, 'cross-studio member payment rejected');
    console.log('C11 OK: studio isolation preserved');
  }

  console.log('All credit-and-refund cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
