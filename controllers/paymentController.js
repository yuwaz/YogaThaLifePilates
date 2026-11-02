const { Payment, Member, PaymentMethod } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

// One consistent balance rule: balance = net package charges − signed payments.
// Positive amount = payment (reduces debt); negative amount = refund (increases
// balance / consumes member credit). Zero is rejected. A refund may not exceed
// the member's available credit (the amount by which the balance is below zero).
function validateSignedAmount(amount) {
  if (amount === undefined || amount === null || isNaN(amount) || Number(amount) === 0) {
    return { error: 'Amount must be a non-zero number (negative for refunds)' };
  }
  return { value: Number(amount) };
}

function validateRefundAgainstCredit(member, signedAmount) {
  if (signedAmount >= 0) return null; // payments need no credit check
  const credit = Math.max(0, -Number(member.totalDebt));
  if (credit <= 0) {
    return 'Üyenin iade edilebilecek kredi bakiyesi yok.';
  }
  if (Math.abs(signedAmount) > credit) {
    return `İade tutarı üyenin kredi bakiyesini aşamaz (kredi: ${credit}).`;
  }
  return null;
}

// GET /settings/payments
exports.getPayments = async (req, res) => {
  try {
    console.log('GET /settings/payments hit');
    const payments = await Payment.findAll({
      where: withStudioWhere(req, {}),
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
    const studioId = getAuthenticatedStudioId(req);
    if (!memberId || amount === undefined || amount === null || !paymentMethodId || !date) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const parsed = validateSignedAmount(amount);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId }) });
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: paymentMethodId }) });
    if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    const refundError = validateRefundAgainstCredit(member, parsed.value);
    if (refundError) return res.status(400).json({ message: refundError });
    const payment = await Payment.create({ memberId, amount: parsed.value, paymentMethodId, date, studioId });
    member.totalDebt = Number(member.totalDebt) - parsed.value;
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
    const payment = await Payment.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // Save old amount for debt adjustment
    const oldAmount = parseFloat(payment.amount);
    let newAmount = oldAmount;
    if (amount !== undefined) {
      const parsed = validateSignedAmount(amount);
      if (parsed.error) return res.status(400).json({ message: parsed.error });
      newAmount = parsed.value;
    }
    if (paymentMethodId !== undefined) {
      const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: paymentMethodId }) });
      if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
      payment.paymentMethodId = paymentMethodId;
    }
    if (date !== undefined) payment.date = date;

    // Adjust member's totalDebt by the difference (signed: refunds negative).
    const member = await Member.findOne({ where: withStudioWhere(req, { id: payment.memberId }) });
    if (member) {
      // Formula: member.totalDebt = member.totalDebt - (newAmount - oldAmount)
      const nextDebt = parseFloat(member.totalDebt) - (newAmount - oldAmount);
      // Refund-direction change: the resulting credit may not exceed the credit
      // available before this payment plus the credit this payment itself granted.
      if (newAmount < oldAmount) {
        const creditBefore = Math.max(0, -parseFloat(member.totalDebt));
        const maxResultingCredit = creditBefore + Math.max(0, oldAmount);
        const resultingCredit = Math.max(0, -nextDebt);
        if (resultingCredit > maxResultingCredit) {
          return res.status(400).json({ message: `İade tutarı üyenin kredi bakiyesini aşamaz (kredi: ${creditBefore}).` });
        }
      }
      payment.amount = newAmount;
      await payment.save();
      member.totalDebt = nextDebt;
      await member.save();
    } else {
      payment.amount = newAmount;
      await payment.save();
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
    const payment = await Payment.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // Store memberId and amount before deleting
    const memberId = payment.memberId;
    const amount = parseFloat(payment.amount);

    await payment.destroy();

    // After deleting, load member and restore debt
    const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId }) });
    if (!member) return res.status(404).json({ message: 'Member not found' });
    member.totalDebt = parseFloat(member.totalDebt) + amount;
    await member.save();

    res.sendStatus(204);
  } catch (err) {
    console.error('Error in DELETE /settings/payments/:id:', err);
    res.status(500).json({ message: err.message });
  }
};
