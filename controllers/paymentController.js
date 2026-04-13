const { Payment, Member, PaymentMethod } = require('../models');

// GET /settings/payments
exports.getPayments = async (req, res) => {
  try {
    console.log('GET /settings/payments hit');
    const payments = await Payment.findAll({
      include: [
        { model: Member, attributes: ['id', 'name'] },
        { model: PaymentMethod, attributes: ['id', 'name'] }
      ]
    });
    res.json(payments);
  } catch (err) {
    console.error('Error in GET /settings/payments:', err);
    res.status(500).json({ message: err.message });
  }
};

// POST /settings/payments
exports.createPayment = async (req, res) => {
  try {
    console.log('POST /settings/payments hit');
    const { memberId, amount, paymentMethodId, date } = req.body;
    if (!memberId || !amount || !paymentMethodId || !date) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const member = await Member.findByPk(memberId);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const payment = await Payment.create({ memberId, amount, paymentMethodId, date });
    member.totalDebt = Number(member.totalDebt) - Number(amount);
    await member.save();
    res.status(201).json(payment);
  } catch (err) {
    console.error('Error in POST /settings/payments:', err);
    res.status(500).json({ message: err.message });
  }
};

// PUT /settings/payments/:id
exports.updatePayment = async (req, res) => {
  try {
    console.log('PUT /settings/payments/:id hit');
    const { amount, paymentMethodId, date } = req.body;
    const payment = await Payment.findByPk(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // Save old amount for debt adjustment
    const oldAmount = parseFloat(payment.amount);
    let newAmount = oldAmount;
    if (amount !== undefined) {
      payment.amount = amount;
      newAmount = parseFloat(amount);
    }
    if (paymentMethodId !== undefined) payment.paymentMethodId = paymentMethodId;
    if (date !== undefined) payment.date = date;
    await payment.save();

    // Adjust member's totalDebt by the difference
    const member = await Member.findByPk(payment.memberId);
    if (member) {
      // Formula: member.totalDebt = member.totalDebt - (newAmount - oldAmount)
      member.totalDebt = parseFloat(member.totalDebt) - (newAmount - oldAmount);
      await member.save();
    }

    res.json(payment);
  } catch (err) {
    console.error('Error in PUT /settings/payments/:id:', err);
    res.status(500).json({ message: err.message });
  }
};

// DELETE /settings/payments/:id
exports.deletePayment = async (req, res) => {
  try {
    console.log('DELETE /settings/payments/:id hit');
    const payment = await Payment.findByPk(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // Store memberId and amount before deleting
    const memberId = payment.memberId;
    const amount = parseFloat(payment.amount);

    await payment.destroy();

    // After deleting, load member and restore debt
    const member = await Member.findByPk(memberId);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    member.totalDebt = parseFloat(member.totalDebt) + amount;
    await member.save();

    res.sendStatus(204);
  } catch (err) {
    console.error('Error in DELETE /settings/payments/:id:', err);
    res.status(500).json({ message: err.message });
  }
};
