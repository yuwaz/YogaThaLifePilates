const { Equipment, Reservation, Salon } = require('../models');
const {
  withStudioWhere,
  getAuthenticatedStudioId,
  parsePositiveIntegerId,
} = require('../middleware/tenantContext');

exports.createEquipment = async (req, res) => {
  try {
    const { name, type, salonId } = req.body;
    if (!name || !type || !salonId) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || typeof type !== 'string') return res.status(400).json({ error: 'Invalid field types' });
    let parsedSalonId;
    try {
      parsedSalonId = parsePositiveIntegerId(salonId, 'salonId');
    } catch {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (!['Mat', 'Reformer'].includes(type)) return res.status(400).json({ error: 'Invalid equipment type' });
    const salon = await Salon.findOne({ where: withStudioWhere(req, { id: parsedSalonId }) });
    if (!salon) return res.sendStatus(404);

    const studioId = getAuthenticatedStudioId(req);
    const equipment = await Equipment.create({ name, type, salonId: parsedSalonId, studioId });
    res.status(201).json(equipment);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.getEquipment = async (req, res) => {
  const equipment = await Equipment.findAll({ where: withStudioWhere(req, {}) });
  res.json(equipment);
};

exports.getEquipmentById = async (req, res) => {
  const equipment = await Equipment.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!equipment) return res.sendStatus(404);
  res.json(equipment);
};

exports.updateEquipment = async (req, res) => {
  try {
    const { name, type, salonId } = req.body;
    const equipment = await Equipment.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!equipment) return res.sendStatus(404);
    if (name) equipment.name = name;
    if (type) equipment.type = type;
    if (typeof salonId !== 'undefined') {
      let parsedSalonId;
      try {
        parsedSalonId = parsePositiveIntegerId(salonId, 'salonId');
      } catch {
        return res.status(400).json({ error: 'Invalid field types' });
      }

      const salon = await Salon.findOne({ where: withStudioWhere(req, { id: parsedSalonId }) });
      if (!salon) return res.sendStatus(404);
      equipment.salonId = parsedSalonId;
    }
    await equipment.save();
    res.json(equipment);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.deleteEquipment = async (req, res) => {
  const equipment = await Equipment.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!equipment) return res.sendStatus(404);

  const reservationCount = await Reservation.count({ where: withStudioWhere(req, { equipmentId: equipment.id }) });
  if (reservationCount > 0) {
    return res.status(400).json({
      error: 'This equipment cannot be deleted because it is used by one or more reservations.',
    });
  }

  await equipment.destroy();
  res.sendStatus(204);
};
