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

exports.createPaymentMethod = async (req, res) => {
  try {
    const { name } = req.body;
    const paymentMethod = await PaymentMethod.create({ name });
    res.status(201).json(paymentMethod);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getPaymentMethods = async (req, res) => {
  const paymentMethods = await PaymentMethod.findAll();
  res.json(paymentMethods);
};

exports.getPaymentMethod = async (req, res) => {
  const paymentMethod = await PaymentMethod.findByPk(req.params.id);
  if (!paymentMethod) return res.sendStatus(404);
  res.json(paymentMethod);
};

exports.updatePaymentMethod = async (req, res) => {
  try {
    const { name } = req.body;
    const paymentMethod = await PaymentMethod.findByPk(req.params.id);
    if (!paymentMethod) return res.sendStatus(404);
    if (name) paymentMethod.name = name;
    await paymentMethod.save();
    res.json(paymentMethod);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  const paymentMethod = await PaymentMethod.findByPk(req.params.id);
  if (!paymentMethod) return res.sendStatus(404);
  await paymentMethod.destroy();
  res.sendStatus(204);
};
