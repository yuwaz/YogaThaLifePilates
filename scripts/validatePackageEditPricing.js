// Disposable validator (not part of product code): regression coverage for
// editing assigned-package pricing — discount changes, paid packages, member
// credit, edit-then-delete, validation, immutable-field rejection, cross-studio
// isolation and optimistic concurrency — against an isolated temp SQLite DB.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-edit-'));
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
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const pkg = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });
  const payMethodA = await PaymentMethod.create({ name: 'Cash', studioId: studioA.id });

  const asAdminA = { id: adminA.id, role: 'admin', studioId: studioA.id, assignedSalonIds: [], permissions: [] };
  const asAdminB = { id: adminB.id, role: 'admin', studioId: studioB.id, assignedSalonIds: [], permissions: [] };

  let phoneSeq = 0;
  async function makeMember(name, totalDebt = 0, studioId = studioA.id) {
    phoneSeq += 1;
    const phone = `+9054666${String(phoneSeq).padStart(5, '0')}`;
    return Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      remainingLessons: 0, totalDebt, isActive: true, studioId,
    });
  }

  async function debtOf(memberId) {
    return Number((await Member.findOne({ where: { id: memberId } })).totalDebt);
  }
  async function lessonsOf(memberId) {
    return Number((await Member.findOne({ where: { id: memberId } })).remainingLessons);
  }

  async function addPackage(memberId, body = {}) {
    const res = mockRes();
    await memberController.addLessonPackage(
      reqFor(asAdminA, { lessonPackageId: pkg.id, ...body }, { params: { id: memberId } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function editPackage(memberId, assignedPackageId, body, asUser = asAdminA) {
    const res = mockRes();
    await memberController.updateAssignedLessonPackage(
      reqFor(asUser, body, { params: { memberId, assignedPackageId } }), res);
    return res;
  }

  async function assignmentOf(memberId) {
    return MemberLessonPackage.findOne({ where: { memberId }, order: [['id', 'DESC']] });
  }

  // --- E1: add a discount to an undiscounted assignment ---
  {
    const m = await makeMember('E1');
    await addPackage(m.id); // +1000
    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { discountType: 'percent', discountValue: 25 });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.finalPrice, 750);
    assert.strictEqual(res.body.oldFinalPrice, 1000);
    assert.strictEqual(await debtOf(m.id), 750, 'debt shifted by -250');
    assert.strictEqual(await lessonsOf(m.id), 10, 'lessons unchanged');
    const persisted = await assignmentOf(m.id);
    assert.strictEqual(Number(persisted.finalPrice), 750);
    assert.strictEqual(persisted.discountType, 'percent');
    assert.strictEqual(Number(persisted.discountValue), 25);
    console.log('E1 OK: discount added to existing assignment');
  }

  // --- E2: change discount on a discounted assignment ---
  {
    const m = await makeMember('E2');
    await addPackage(m.id, { discountType: 'amount', discountValue: 200 }); // 800
    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { discountType: 'percent', discountValue: 50 }); // 500
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.finalPrice, 500);
    assert.strictEqual(await debtOf(m.id), 500, 'debt shifted by -300');
    console.log('E2 OK: discount changed');
  }

  // --- E3: remove discount entirely ---
  {
    const m = await makeMember('E3');
    await addPackage(m.id, { discountType: 'amount', discountValue: 400 }); // 600
    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { discountType: null, discountValue: null });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.finalPrice, 1000, 'back to full price');
    assert.strictEqual(await debtOf(m.id), 1000, 'debt shifted by +400');
    console.log('E3 OK: discount removed');
  }

  // --- E4: edit originalPrice (catalog price was wrong at assignment) ---
  {
    const m = await makeMember('E4');
    await addPackage(m.id); // 1000
    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { originalPrice: 1200, discountType: 'percent', discountValue: 10 });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.originalPrice, 1200);
    assert.strictEqual(res.body.finalPrice, 1080);
    assert.strictEqual(await debtOf(m.id), 1080, 'debt shifted by +80');
    console.log('E4 OK: originalPrice edited with discount recomputed');
  }

  // --- E5: edit on a PAID package (debt 0) -> goes into credit ---
  {
    const m = await makeMember('E5');
    await addPackage(m.id); // +1000
    const pay = mockRes();
    await paymentController.createPayment(
      reqFor(asAdminA, { memberId: m.id, amount: 1000, paymentMethodId: payMethodA.id, date: '2026-11-03' }), pay);
    assert.strictEqual(pay.statusCode, 201);
    assert.strictEqual(await debtOf(m.id), 0, 'paid off');

    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { discountType: 'amount', discountValue: 300 }); // 700
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(await debtOf(m.id), -300, 'paid package discounted -> credit -300 (no clamp)');
    const payments = await Payment.findAll({ where: { memberId: m.id } });
    assert.strictEqual(payments.length, 1, 'payment record untouched');
    console.log('E5 OK: edit on paid package -> credit, payment history preserved');
  }

  // --- E6: edit on member already in credit ---
  {
    const m = await makeMember('E6', -500);
    await addPackage(m.id); // -500 + 1000 = 500
    assert.strictEqual(await debtOf(m.id), 500);
    const a = await assignmentOf(m.id);
    const res = await editPackage(m.id, a.id, { discountType: 'percent', discountValue: 100 }); // 0
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(await debtOf(m.id), -500, 'credit restored exactly');
    console.log('E6 OK: edit preserves member credit');
  }

  // --- E7: edit-then-delete reverses the EDITED price ---
  {
    const m = await makeMember('E7');
    await addPackage(m.id); // 1000
    const a = await assignmentOf(m.id);
    await editPackage(m.id, a.id, { discountType: 'amount', discountValue: 250 }); // 750
    assert.strictEqual(await debtOf(m.id), 750);
    const del = mockRes();
    await memberController.deleteAssignedLessonPackage(
      reqFor(asAdminA, {}, { params: { memberId: m.id, assignedPackageId: a.id } }), del);
    assert.strictEqual(del.statusCode, 204);
    assert.strictEqual(await debtOf(m.id), 0, 'deletion reversed edited 750');
    console.log('E7 OK: edit-then-delete reverses edited price');
  }

  // --- E8: validation ---
  {
    const m = await makeMember('E8');
    await addPackage(m.id);
    const a = await assignmentOf(m.id);
    const cases = [
      [{ originalPrice: -5 }, 'negative originalPrice'],
      [{ originalPrice: 'abc' }, 'non-numeric originalPrice'],
      [{ discountType: 'amount', discountValue: 2000 }, 'amount > originalPrice'],
      [{ discountType: 'percent', discountValue: 101 }, 'percent > 100'],
      [{ discountType: 'bogus' }, 'invalid discountType'],
      [{ lessonPackageId: 999 }, 'immutable lessonPackageId'],
      [{ assignedAt: '2020-01-01' }, 'immutable assignedAt'],
      [{ finalPrice: 1 }, 'immutable finalPrice (server-computed)'],
      [{ remainingLessons: 99 }, 'unknown field'],
    ];
    for (const [body, label] of cases) {
      const res = await editPackage(m.id, a.id, body);
      assert.strictEqual(res.statusCode, 400, `${label} rejected, got ${res.statusCode}`);
    }
    assert.strictEqual(await debtOf(m.id), 1000, 'no invalid edit persisted');
    const persisted = await assignmentOf(m.id);
    assert.strictEqual(Number(persisted.finalPrice), 1000, 'assignment unchanged');
    console.log('E8 OK: validation + immutable-field rejection');
  }

  // --- E9: cross-studio isolation ---
  {
    const m = await makeMember('E9');
    await addPackage(m.id);
    const a = await assignmentOf(m.id);
    // Studio B admin tries to edit studio A's assignment.
    const res = await editPackage(m.id, a.id, { discountType: 'percent', discountValue: 50 }, asAdminB);
    assert.strictEqual(res.statusCode, 404, 'cross-studio edit rejected');
    assert.strictEqual(await debtOf(m.id), 1000, 'unchanged');
    console.log('E9 OK: cross-studio isolation');
  }

  // --- E10: optimistic concurrency -> stale edit rejected with 409 ---
  {
    const m = await makeMember('E10');
    await addPackage(m.id); // 1000
    const a = await assignmentOf(m.id);

    // Simulate two concurrent edits: first succeeds, second (stale read) must 409.
    // We emulate staleness by editing directly via model between the controller's
    // read and update — approximated here by two sequential edits where the second
    // reuses the FIRST edit's pre-read state. Since the controller re-reads inside
    // the transaction with an optimistic lock on originalPrice/finalPrice, a direct
    // model update in between triggers the 409 path.
    const res1 = await editPackage(m.id, a.id, { discountType: 'amount', discountValue: 100 }); // 900
    assert.strictEqual(res1.statusCode, 200);

    // Directly mutate the row to simulate a concurrent edit after a stale read.
    await MemberLessonPackage.update(
      { finalPrice: 500, discountValue: 500 },
      { where: { id: a.id } }
    );
    // A controller edit whose in-transaction lock no longer matches the stale
    // pre-image must 409. We force the stale pre-image by calling the controller
    // with a body computed from the pre-mutation state — the lock compares against
    // the CURRENT row, so we instead verify the lock rejects when the row changed
    // between the controller's initial read and the locked update. To exercise this
    // deterministically, we monkey-patch MemberLessonPackage.findOne to return a
    // stale first read.
    const originalFindOne = MemberLessonPackage.findOne;
    let callCount = 0;
    MemberLessonPackage.findOne = async function (...args) {
      callCount += 1;
      if (callCount === 1) {
        // First (pre-transaction) read: return stale pricing (finalPrice 900).
        const row = await originalFindOne.apply(this, args);
        row.finalPrice = 900;
        row.originalPrice = 1000;
        return row;
      }
      return originalFindOne.apply(this, args);
    };
    try {
      const res2 = await editPackage(m.id, a.id, { discountType: 'percent', discountValue: 10 });
      assert.strictEqual(res2.statusCode, 409, `stale concurrent edit rejected, got ${res2.statusCode}: ${JSON.stringify(res2.body)}`);
    } finally {
      MemberLessonPackage.findOne = originalFindOne;
    }
    // The rejected stale edit touched nothing: balance reflects only the first
    // successful edit (1000 -> 900). The direct row mutation changed only the
    // assignment pricing (simulating a concurrent edit), not member.totalDebt.
    assert.strictEqual(await debtOf(m.id), 900, 'balance not corrupted by rejected stale edit');
    const persisted = await assignmentOf(m.id);
    assert.strictEqual(Number(persisted.finalPrice), 500, 'concurrent edit row preserved, stale edit not applied');
    console.log('E10 OK: optimistic concurrency rejects stale edits');
  }

  console.log('All package-edit-pricing cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
