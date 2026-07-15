const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

function normalizeAuthArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  return [];
}

function normalizeStudioId(value) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 1;
}

function buildAuthPayload(userLike) {
  const assignedSalonIds = normalizeAuthArray(userLike && userLike.assignedSalonIds);
  const permissions = normalizeAuthArray(userLike && userLike.permissions);
  const studioId = normalizeStudioId(userLike && userLike.studioId);

  return {
    id: userLike.id,
    role: userLike.role,
    assignedSalonIds,
    permissions,
    studioId,
  };
}

function signAuthToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

module.exports = {
  buildAuthPayload,
  signAuthToken,
};
