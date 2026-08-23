const { Op } = require('sequelize');
const { Expense, Salon, PaymentMethod } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

function validateRequiredFields(body) {
  const { salonId, title, amount, category, date } = body;
  return salonId !== undefined && title && amount !== undefined && category && date;
}

exports.getExpenses = async (req, res) => {
  try {
    const { salonId, startDate, endDate, category, paymentMethodId } = req.query;
    const where = withStudioWhere(req, {});

    if (salonId !== undefined) where.salonId = Number(salonId);
    if (category) where.category = category;
    if (paymentMethodId !== undefined) where.paymentMethodId = Number(paymentMethodId);

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date[Op.gte] = startDate;
      if (endDate) where.date[Op.lte] = endDate;
    }

    const expenses = await Expense.findAll({
      where,
      include: [
        { model: Salon, attributes: ['id', 'name', 'type'] },
        { model: PaymentMethod, attributes: ['id', 'name'] },
      ],
      order: [['date', 'DESC'], ['id', 'DESC']],
    });

    res.json(expenses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({ where: withStudioWhere(req, { id: req.params.id }),
      include: [
        { model: Salon, attributes: ['id', 'name', 'type'] },
        { model: PaymentMethod, attributes: ['id', 'name'] },
      ],
    });

    if (!expense) return res.status(404).json({ message: 'Expense not found' });
    res.json(expense);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createExpense = async (req, res) => {
  try {
    if (!validateRequiredFields(req.body)) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const { salonId, title, description, amount, category, date, paymentMethodId, notes } = req.body;
    const studioId = getAuthenticatedStudioId(req);
    const salon = await Salon.findOne({ where: withStudioWhere(req, { id: salonId }) });
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    if (paymentMethodId !== undefined && paymentMethodId !== null) {
      const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: paymentMethodId }) });
      if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    }
    const expense = await Expense.create({
      salonId,
      title,
      description,
      amount,
      category,
      date,
      paymentMethodId: paymentMethodId ?? null,
      notes,
      studioId,
    });

    res.status(201).json(expense);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    if (!validateRequiredFields(req.body)) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const expense = await Expense.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    const { salonId, title, description, amount, category, date, paymentMethodId, notes } = req.body;
    const salon = await Salon.findOne({ where: withStudioWhere(req, { id: salonId }) });
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    if (paymentMethodId !== undefined && paymentMethodId !== null) {
      const paymentMethod = await PaymentMethod.findOne({ where: withStudioWhere(req, { id: paymentMethodId }) });
      if (!paymentMethod) return res.status(404).json({ message: 'Payment method not found' });
    }
    expense.salonId = salonId;
    expense.title = title;
    expense.description = description;
    expense.amount = amount;
    expense.category = category;
    expense.date = date;
    expense.paymentMethodId = paymentMethodId ?? null;
    expense.notes = notes;

    await expense.save();
    res.json(expense);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    await expense.destroy();
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};