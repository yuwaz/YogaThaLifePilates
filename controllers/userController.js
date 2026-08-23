const { User, Salon } = require('../models');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');
const { getStudioOwnerUserId } = require('../services/studioOwnerService');

function toSafeUserPayload(user) {
  const payload = user && typeof user.get === 'function' ? user.get({ plain: true }) : user;
  if (!payload || typeof payload !== 'object') return payload;
  const { password, ...safePayload } = payload;
  return safePayload;
}

async function validateAssignedSalonIdsInStudio(req, assignedSalonIds) {
  if (typeof assignedSalonIds === 'undefined') {
    return;
  }

  if (!Array.isArray(assignedSalonIds)) {
    throw { status: 400, message: 'assignedSalonIds must be an array' };
  }

  if (assignedSalonIds.length === 0) {
    return;
  }

  const normalizedSalonIds = assignedSalonIds.map((value) => Number(value));
  if (normalizedSalonIds.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw { status: 404, message: 'Not found' };
  }

  const uniqueSalonIds = [...new Set(normalizedSalonIds)];
  const salonCount = await Salon.count({
    where: withStudioWhere(req, {
      id: { [Op.in]: uniqueSalonIds },
    }),
  });

  if (salonCount !== uniqueSalonIds.length) {
    throw { status: 404, message: 'Not found' };
  }
}

async function usernameExistsInStudio(req, username, excludeUserId) {
  const where = withStudioWhere(req, { username });
  if (excludeUserId !== undefined && excludeUserId !== null) {
    where.id = { [Op.ne]: Number(excludeUserId) };
  }

  const existing = await User.findOne({ where, attributes: ['id'] });
  return Boolean(existing);
}

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

    await validateAssignedSalonIdsInStudio(req, assignedSalonIds || []);

    if (await usernameExistsInStudio(req, username)) {
      return res.status(400).json({
        error: 'Validation error',
        details: [{ message: 'Username already exists in this studio', path: 'username', value: username }],
      });
    }

    const hash = await bcrypt.hash(password, 10);
    try {
      const user = await User.create({
        username,
        password: hash,
        role,
        assignedSalonIds: assignedSalonIds || [],
        permissions: permissions || [],
        studioId: getAuthenticatedStudioId(req),
        groupSessionFee: groupSessionFee === undefined ? 0 : Number(groupSessionFee),
        individualSessionFee: individualSessionFee === undefined ? 0 : Number(individualSessionFee),
      });
      res.status(201).json(toSafeUserPayload(user));
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
    res.status(err.status || 400).json({ error: err.message || 'Server error' });
  }
};

exports.getUsers = async (req, res) => {
  const users = await User.findAll({
    where: withStudioWhere(req, {}),
    attributes: { exclude: ['password'] },
  });
  res.json(users);
};

exports.getInstructors = async (req, res) => {
  const studioId = getAuthenticatedStudioId(req);
  const attributes = ['id', 'username', 'role', 'assignedSalonIds', 'permissions', 'groupSessionFee', 'individualSessionFee'];
  const instructors = await User.findAll({
    where: withStudioWhere(req, { role: 'instructor' }),
    attributes,
  });

  // The Studio owner admin is also teaching-capable; keep their real role: 'admin' (never lie about role).
  const ownerUserId = await getStudioOwnerUserId(studioId);
  if (ownerUserId) {
    const owner = await User.findOne({
      where: withStudioWhere(req, { id: ownerUserId, role: 'admin' }),
      attributes,
    });
    if (owner) {
      instructors.push(owner);
    }
  }

  res.json(instructors);
};

exports.getUser = async (req, res) => {
  const user = await User.findOne({
    where: withStudioWhere(req, { id: req.params.id }),
    attributes: { exclude: ['password'] },
  });
  if (!user) return res.sendStatus(404);
  res.json(user);
};

exports.resetInstructorPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: 'Missing required fields: newPassword' });
    }
    if (typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }

    const instructor = await User.findOne({
      where: withStudioWhere(req, { id: req.params.id, role: 'instructor' }),
    });
    if (!instructor) return res.sendStatus(404);

    instructor.password = await bcrypt.hash(newPassword, 10);
    await instructor.save({ fields: ['password'] });
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Server error' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { username, password, newPassword, role, assignedSalonIds, permissions, groupSessionFee, individualSessionFee } = req.body;
    const user = await User.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!user) return res.sendStatus(404);
    const ownerUserId = await getStudioOwnerUserId(getAuthenticatedStudioId(req));
    if (ownerUserId === user.id && role && role !== 'admin') {
      return res.status(400).json({ error: 'Studio owner role cannot be changed' });
    }
    if (username && typeof username !== 'string') return res.status(400).json({ error: 'Invalid username type' });
    if (role && typeof role !== 'string') return res.status(400).json({ error: 'Invalid role type' });
    if (typeof newPassword !== 'undefined' && newPassword !== null && typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Invalid newPassword type' });
    }
    if (typeof password !== 'undefined' && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid password type' });
    }
    if (assignedSalonIds && !Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
    if (permissions && !Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be an array' });
    if (groupSessionFee !== undefined && (isNaN(Number(groupSessionFee)) || Number(groupSessionFee) < 0)) {
      return res.status(400).json({ error: 'groupSessionFee must be a non-negative number' });
    }
    if (individualSessionFee !== undefined && (isNaN(Number(individualSessionFee)) || Number(individualSessionFee) < 0)) {
      return res.status(400).json({ error: 'individualSessionFee must be a non-negative number' });
    }

    await validateAssignedSalonIdsInStudio(req, assignedSalonIds);

    if (username && await usernameExistsInStudio(req, username, user.id)) {
      return res.status(400).json({
        error: 'Validation error',
        details: [{ message: 'Username already exists in this studio', path: 'username', value: username }],
      });
    }

    const requestedNewPassword = typeof newPassword === 'string' && newPassword.trim() !== ''
      ? newPassword
      : null;
    const requestedLegacyPassword = !requestedNewPassword && typeof password === 'string' && password.trim() !== ''
      ? password
      : null;
    const passwordToApply = requestedNewPassword || requestedLegacyPassword;
    const trimmedPasswordToApply = typeof passwordToApply === 'string' ? passwordToApply.trim() : '';

    if (passwordToApply) {
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'ADMIN_REQUIRED' });
      }

      if (trimmedPasswordToApply.length < 6) {
        return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
      }
    }

    if (username) user.username = username;
    if (role) user.role = role;
    if (assignedSalonIds) user.assignedSalonIds = assignedSalonIds;
    if (permissions) user.permissions = permissions;
    if (groupSessionFee !== undefined) user.groupSessionFee = Number(groupSessionFee);
    if (individualSessionFee !== undefined) user.individualSessionFee = Number(individualSessionFee);
    if (passwordToApply) user.password = await bcrypt.hash(passwordToApply, 10);
    await user.save();
    res.json(toSafeUserPayload(user));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Server error' });
  }
};

exports.deleteUser = async (req, res) => {
  const user = await User.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!user) return res.sendStatus(404);
  const ownerUserId = await getStudioOwnerUserId(getAuthenticatedStudioId(req));
  if (ownerUserId === user.id) {
    return res.status(400).json({ error: 'Studio owner cannot be deleted' });
  }
  await user.destroy();
  res.sendStatus(204);
};
