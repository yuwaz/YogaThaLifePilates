const { Op } = require('sequelize');
const { User } = require('../models');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 120;
const ALLOWED_USER_ROLES = ['admin', 'instructor'];

const USER_SAFE_ATTRIBUTES = [
  'id',
  'username',
  'role',
  'assignedSalonIds',
  'permissions',
  'groupSessionFee',
  'individualSessionFee',
  'studioId',
  'createdAt',
  'updatedAt',
];

function createValidationError(message) {
  const error = new Error(message);
  error.code = 'BACKOFFICE_VALIDATION_ERROR';
  return error;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function normalizePagination(options = {}) {
  const parsedOffset = options.offset === undefined ? 0 : Number(options.offset);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw createValidationError('offset must be a non-negative integer');
  }

  const requestedLimit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    throw createValidationError('limit must be a positive integer');
  }

  return {
    offset: parsedOffset,
    limit: Math.min(requestedLimit, MAX_LIMIT),
  };
}

function normalizeUsernameSearch(search) {
  if (search === undefined || search === null) {
    return null;
  }

  if (typeof search !== 'string') {
    throw createValidationError('search must be a string');
  }

  const normalized = search.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_SEARCH_LENGTH) {
    throw createValidationError(`search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }

  return normalized;
}

function normalizeRoleFilter(role) {
  if (role === undefined || role === null) {
    return null;
  }

  if (typeof role !== 'string' || !ALLOWED_USER_ROLES.includes(role)) {
    throw createValidationError('role filter is invalid');
  }

  return role;
}

function sanitizeUser(userLike) {
  if (!userLike) return null;

  const user = userLike && typeof userLike.get === 'function'
    ? userLike.get({ plain: true })
    : userLike;

  const safe = {};
  for (const key of USER_SAFE_ATTRIBUTES) {
    safe[key] = user[key];
  }
  return safe;
}

async function listStudioUsers(studioId, options = {}) {
  const normalizedStudioId = parsePositiveInteger(studioId, 'studioId');
  const pagination = normalizePagination(options);
  const normalizedRole = normalizeRoleFilter(options.role);
  const search = normalizeUsernameSearch(options.search);

  const where = {
    studioId: normalizedStudioId,
  };

  if (normalizedRole) {
    where.role = normalizedRole;
  }

  if (search) {
    where.username = { [Op.like]: `%${search}%` };
  }

  const result = await User.findAndCountAll({
    where,
    attributes: USER_SAFE_ATTRIBUTES,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return {
    total: result.count,
    limit: pagination.limit,
    offset: pagination.offset,
    users: result.rows.map(sanitizeUser),
  };
}

async function getStudioUserById(studioId, userId) {
  const normalizedStudioId = parsePositiveInteger(studioId, 'studioId');
  const normalizedUserId = parsePositiveInteger(userId, 'userId');

  const user = await User.findOne({
    where: {
      id: normalizedUserId,
      studioId: normalizedStudioId,
    },
    attributes: USER_SAFE_ATTRIBUTES,
  });

  return sanitizeUser(user);
}

module.exports = {
  listStudioUsers,
  getStudioUserById,
  sanitizeUser,
};