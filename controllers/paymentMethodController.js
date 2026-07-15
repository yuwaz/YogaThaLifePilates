// ...existing code...

// Payment logic is handled in memberController for add, but add delete logic here
const { Payment, Member } = require('../models');

exports.deletePayment = async (req, res) => {
  try {
    const payment = await Payment.findByPk(req.params.id);
    if (!payment) return res.sendStatus(404);
    const member = await Member.findByPk(payment.memberId);
    if (member) {
      member.totalDebt = Number(member.totalDebt) + Number(payment.amount);
      await member.save();
    }
    await payment.destroy();
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
const { PaymentMethod } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

exports.createPaymentMethod = async (req, res) => {
  try {
    console.log('POST /settings/paymentMethods hit');
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Missing required fields' });
    if (typeof name !== 'string') return res.status(400).json({ message: 'Invalid field type' });
    const paymentMethod = await PaymentMethod.create({
      name,
      studioId: getAuthenticatedStudioId(req),
    });
    res.status(201).json(paymentMethod);
  } catch (err) {
    console.error('Error in POST /settings/paymentMethods:', err);
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getPaymentMethods = async (req, res) => {
  try {
    console.log('GET /settings/paymentMethods hit');
    const paymentMethods = await PaymentMethod.findAll({ where: withStudioWhere(req, {}) });
    res.json(paymentMethods);
  } catch (err) {
    console.error('Error in GET /settings/paymentMethods:', err);
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getPaymentMethod = async (req, res) => {
  try {
    console.log('GET /settings/paymentMethods/:id hit');
    const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    res.json(paymentMethod);
  } catch (err) {
    console.error('Error in GET /settings/paymentMethods/:id:', err);
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updatePaymentMethod = async (req, res) => {
  try {
    console.log('PUT /settings/paymentMethods/:id hit');
    const { name } = req.body;
    const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    if (name) paymentMethod.name = name;
    await paymentMethod.save();
    res.json(paymentMethod);
  } catch (err) {
    console.error('Error in PUT /settings/paymentMethods/:id:', err);
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  try {
    console.log('DELETE /settings/paymentMethods/:id hit');
    const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    await paymentMethod.destroy();
    res.sendStatus(204);
  } catch (err) {
    console.error('Error in DELETE /settings/paymentMethods/:id:', err);
    res.status(err.status || 500).json({ message: err.message });
  }
};
