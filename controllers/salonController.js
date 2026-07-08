const { Salon, Member, Reservation, Equipment, Expense, User } = require('../models');

const normalizeAssignedSalonIds = (assignedSalonIds) => {
  if (Array.isArray(assignedSalonIds)) {
    return assignedSalonIds;
  }

  if (typeof assignedSalonIds === 'string') {
    try {
      const parsedAssignedSalonIds = JSON.parse(assignedSalonIds);
      return Array.isArray(parsedAssignedSalonIds) ? parsedAssignedSalonIds : [];
    } catch (err) {
      return [];
    }
  }

  return [];
};

const hasAssignedSalon = (records, salonId) => records.some(({ assignedSalonIds }) => (
  normalizeAssignedSalonIds(assignedSalonIds).some((assignedSalonId) => Number(assignedSalonId) === salonId)
));

exports.createSalon = async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || typeof type !== 'string') return res.status(400).json({ error: 'Invalid field types' });
    if (!['Yoga', 'Pilates'].includes(type)) return res.status(400).json({ error: 'Invalid salon type' });
    const salon = await Salon.create({ name, type });
    res.status(201).json(salon);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getSalons = async (req, res) => {
  const salons = await Salon.findAll();
  res.json(salons);
};

exports.getSalon = async (req, res) => {
  const salon = await Salon.findByPk(req.params.id);
  if (!salon) return res.sendStatus(404);
  res.json(salon);
};

exports.updateSalon = async (req, res) => {
  try {
    const { name, type } = req.body;
    const salon = await Salon.findByPk(req.params.id);
    if (!salon) return res.sendStatus(404);
    if (name) salon.name = name;
    if (type) salon.type = type;
    await salon.save();
    res.json(salon);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteSalon = async (req, res) => {
  const salon = await Salon.findByPk(req.params.id);
  if (!salon) return res.sendStatus(404);

  const [members, users, reservationCount, equipmentCount, expenseCount] = await Promise.all([
    Member.findAll({ attributes: ['assignedSalonIds'], raw: true }),
    User.findAll({ attributes: ['assignedSalonIds'], raw: true }),
    Reservation.count({ where: { salonId: salon.id } }),
    Equipment.count({ where: { salonId: salon.id } }),
    Expense.count({ where: { salonId: salon.id } }),
  ]);

  if (
    hasAssignedSalon(members, salon.id)
    || hasAssignedSalon(users, salon.id)
    || reservationCount > 0
    || equipmentCount > 0
    || expenseCount > 0
  ) {
    return res.status(400).json({
      error: 'This salon cannot be deleted because it is currently in use.',
    });
  }

  await salon.destroy();
  res.sendStatus(204);
};
