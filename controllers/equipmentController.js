const { Equipment } = require('../models');

exports.createEquipment = async (req, res) => {
  try {
    const { name, type, salonId } = req.body;
    if (!name || !type || !salonId) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || typeof type !== 'string' || isNaN(salonId)) return res.status(400).json({ error: 'Invalid field types' });
    if (!['Mat', 'Reformer'].includes(type)) return res.status(400).json({ error: 'Invalid equipment type' });
    const equipment = await Equipment.create({ name, type, salonId });
    res.status(201).json(equipment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getEquipment = async (req, res) => {
  const equipment = await Equipment.findAll();
  res.json(equipment);
};

exports.getEquipmentById = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) return res.sendStatus(404);
  res.json(equipment);
};

exports.updateEquipment = async (req, res) => {
  try {
    const { name, type, salonId } = req.body;
    const equipment = await Equipment.findByPk(req.params.id);
    if (!equipment) return res.sendStatus(404);
    if (name) equipment.name = name;
    if (type) equipment.type = type;
    if (salonId) equipment.salonId = salonId;
    await equipment.save();
    res.json(equipment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteEquipment = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) return res.sendStatus(404);
  await equipment.destroy();
  res.sendStatus(204);
};
