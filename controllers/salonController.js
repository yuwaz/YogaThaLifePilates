const { Salon } = require('../models');

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
  await salon.destroy();
  res.sendStatus(204);
};
