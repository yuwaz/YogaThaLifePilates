const { User, Salon } = require('../models');
const bcrypt = require('bcrypt');

exports.createUser = async (req, res) => {
  try {
    const { username, password, role, assignedSalonIds, permissions, groupSessionFee, individualSessionFee } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields: username, password, role' });
    }
    if (typeof username !== 'string' || typeof password !== 'string' || typeof role !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (groupSessionFee !== undefined && (isNaN(Number(groupSessionFee)) || Number(groupSessionFee) < 0)) {
      return res.status(400).json({ error: 'groupSessionFee must be a non-negative number' });
    }
    if (individualSessionFee !== undefined && (isNaN(Number(individualSessionFee)) || Number(individualSessionFee) < 0)) {
      return res.status(400).json({ error: 'individualSessionFee must be a non-negative number' });
    }
    if (role === 'instructor') {
      if (!assignedSalonIds || !Array.isArray(assignedSalonIds)) {
        return res.status(400).json({ error: 'assignedSalonIds must be an array for instructors' });
      }
      // Permissions is optional, but if present must be an array
      if (permissions && !Array.isArray(permissions)) {
        return res.status(400).json({ error: 'permissions must be an array' });
      }
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const user = await User.create({
        username,
        password: hash,
        role,
        assignedSalonIds: assignedSalonIds || [],
        permissions: permissions || [],
        groupSessionFee: groupSessionFee === undefined ? 0 : Number(groupSessionFee),
        individualSessionFee: individualSessionFee === undefined ? 0 : Number(individualSessionFee),
      });
      res.status(201).json(user);
    } catch (dbErr) {
      // Sequelize validation errors
      if (dbErr.name === 'SequelizeValidationError' || dbErr.name === 'SequelizeUniqueConstraintError') {
        const details = dbErr.errors ? dbErr.errors.map(e => ({ message: e.message, path: e.path, value: e.value })) : dbErr.message;
        console.error('User create validation error:', details);
        return res.status(400).json({ error: 'Validation error', details });
      }
      // Other errors
      console.error('User create DB error:', dbErr);
      return res.status(400).json({ error: dbErr.message });
    }
  } catch (err) {
    console.error('User create logic error:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getUsers = async (req, res) => {
  const users = await User.findAll();
  res.json(users);
};

exports.getInstructors = async (req, res) => {
  const instructors = await User.findAll({
    where: { role: 'instructor' },
    attributes: ['id', 'username', 'role', 'assignedSalonIds', 'groupSessionFee', 'individualSessionFee']
  });
  res.json(instructors);
};

exports.getUser = async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) return res.sendStatus(404);
  res.json(user);
};

exports.updateUser = async (req, res) => {
  try {
    const { username, password, role, assignedSalonIds, permissions, groupSessionFee, individualSessionFee } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.sendStatus(404);
    if (username && typeof username !== 'string') return res.status(400).json({ error: 'Invalid username type' });
    if (role && typeof role !== 'string') return res.status(400).json({ error: 'Invalid role type' });
    if (assignedSalonIds && !Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
    if (permissions && !Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be an array' });
    if (groupSessionFee !== undefined && (isNaN(Number(groupSessionFee)) || Number(groupSessionFee) < 0)) {
      return res.status(400).json({ error: 'groupSessionFee must be a non-negative number' });
    }
    if (individualSessionFee !== undefined && (isNaN(Number(individualSessionFee)) || Number(individualSessionFee) < 0)) {
      return res.status(400).json({ error: 'individualSessionFee must be a non-negative number' });
    }
    if (username) user.username = username;
    if (role) user.role = role;
    if (assignedSalonIds) user.assignedSalonIds = assignedSalonIds;
    if (permissions) user.permissions = permissions;
    if (groupSessionFee !== undefined) user.groupSessionFee = Number(groupSessionFee);
    if (individualSessionFee !== undefined) user.individualSessionFee = Number(individualSessionFee);
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
