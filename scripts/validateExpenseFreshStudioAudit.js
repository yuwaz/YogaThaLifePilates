// Disposable audit script: proves whether expenseController.createExpense
// correctly resolves Salon/PaymentMethod for a freshly created (non-Studio-1)
// studio, using real backend-assigned ids (never index-based).
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-audit-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const { sequelize, Studio, Salon, PaymentMethod } = require('../models');
  const expenseController = require('../controllers/expenseController');

  await sequelize.sync({ force: true });

  const studio1 = await Studio.create({ name: 'Legacy Studio', studioCode: 'LEGACY1', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studio2 = await Studio.create({ name: 'Fresh Studio', studioCode: 'FRESH2', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });

  const legacySalon = await Salon.create({ name: 'Legacy Salon', type: 'Yoga', studioId: studio1.id });
  const legacyMethod = await PaymentMethod.create({ name: 'Nakit', studioId: studio1.id });

  const freshSalon = await Salon.create({ name: 'Fresh Salon', type: 'Pilates', studioId: studio2.id });
  const freshMethod = await PaymentMethod.create({ name: 'Kredi Kartı', studioId: studio2.id });

  console.log('Legacy studio id:', studio1.id, 'salonId:', legacySalon.id, 'paymentMethodId:', legacyMethod.id);
  console.log('Fresh studio id:', studio2.id, 'salonId:', freshSalon.id, 'paymentMethodId:', freshMethod.id);

  function mockRes() {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.sendStatus = (code) => { res.statusCode = code; return res; };
    return res;
  }

  // Case A: fresh studio creates expense using its OWN real salon + payment method ids.
  const reqA = {
    user: { studioId: studio2.id },
    body: {
      salonId: freshSalon.id,
      title: 'Kira',
      amount: 100,
      category: 'Kira',
      date: '2026-08-23',
      paymentMethodId: freshMethod.id,
    },
  };
  const resA = mockRes();
  await expenseController.createExpense(reqA, resA);
  console.log('Case A (fresh studio, own real ids) -> status:', resA.statusCode, 'body:', JSON.stringify(resA.body));

  // Case B: fresh studio attempts to use legacy Studio 1's salon id (cross-tenant attempt).
  const reqB = {
    user: { studioId: studio2.id },
    body: {
      salonId: legacySalon.id,
      title: 'Kira',
      amount: 100,
      category: 'Kira',
      date: '2026-08-23',
      paymentMethodId: freshMethod.id,
    },
  };
  const resB = mockRes();
  await expenseController.createExpense(reqB, resB);
  console.log('Case B (fresh studio, cross-tenant legacy salonId) -> status:', resB.statusCode, 'body:', JSON.stringify(resB.body));

  await sequelize.close();
}

run().catch((err) => {
  console.error('AUDIT SCRIPT ERROR:', err);
  process.exit(1);
});
