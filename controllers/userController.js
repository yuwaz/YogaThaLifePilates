const { User, Salon } = require('../models');
const bcrypt = require('bcrypt');

exports.createUser = async (req, res) => {
  try {
    const { username, password, role, assignedSalonIds } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, role, assignedSalonIds });
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getUsers = async (req, res) => {
  const users = await User.findAll();
  res.json(users);
};

exports.getUser = async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) return res.sendStatus(404);
  res.json(user);
};

exports.updateUser = async (req, res) => {
  try {
    const { username, password, role, assignedSalonIds } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.sendStatus(404);
    if (username) user.username = username;
    if (role) user.role = role;
    if (assignedSalonIds) user.assignedSalonIds = assignedSalonIds;
    if (password) user.password = await bcrypt.hash(password, 10);
    await user.save();
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) return res.sendStatus(404);
  await user.destroy();
  res.sendStatus(204);
};
