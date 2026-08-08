const { Op } = require('sequelize');
const { Studio } = require('../models');
const {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_PLANS,
  SUPPORTED_COUNTRY_CODES,
} = require('../models/studioMetadata');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 120;

const STUDIO_SAFE_ATTRIBUTES = [
  'id',
  'name',
  'studioCode',
  'email',
  'phone',
  'country',
  'currency',
  'timezone',
  'subscriptionStatus',
  'subscriptionPlan',
  'trialEndsAt',
  'onboardingCompleted',
  'onboardingStep',
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

  const limit = Math.min(requestedLimit, MAX_LIMIT);
  return {
    offset: parsedOffset,
    limit,
  };
}

function normalizeSearch(search) {
  if (search === undefined || search === null) {
    return null;
  }

  if (typeof search !== 'string') {
    throw createValidationError('search must be a string');
  }

  const normalized = search.trim();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > MAX_SEARCH_LENGTH) {
    throw createValidationError(`search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }

  return normalized;
}

function normalizeFilters(filters = {}) {
  const allowedFilterKeys = new Set([
    'subscriptionStatus',
    'subscriptionPlan',
    'onboardingCompleted',
    'country',
  ]);

  for (const key of Object.keys(filters)) {
    if (!allowedFilterKeys.has(key)) {
      throw createValidationError(`unsupported filter: ${key}`);
    }
  }

  const where = {};

  if (filters.subscriptionStatus !== undefined) {
    if (typeof filters.subscriptionStatus !== 'string' || !SUBSCRIPTION_STATUSES.includes(filters.subscriptionStatus)) {
      throw createValidationError('subscriptionStatus filter is invalid');
    }
    where.subscriptionStatus = filters.subscriptionStatus;
  }

  if (filters.subscriptionPlan !== undefined) {
    if (typeof filters.subscriptionPlan !== 'string' || !SUBSCRIPTION_PLANS.includes(filters.subscriptionPlan)) {
      throw createValidationError('subscriptionPlan filter is invalid');
    }
    where.subscriptionPlan = filters.subscriptionPlan;
  }

  if (filters.onboardingCompleted !== undefined) {
    if (typeof filters.onboardingCompleted !== 'boolean') {
      throw createValidationError('onboardingCompleted filter must be a boolean');
    }
    where.onboardingCompleted = filters.onboardingCompleted;
  }

  if (filters.country !== undefined) {
    if (typeof filters.country !== 'string') {
      throw createValidationError('country filter is invalid');
    }

    const normalizedCountry = filters.country.trim().toUpperCase();
    if (!SUPPORTED_COUNTRY_CODES.includes(normalizedCountry)) {
      throw createValidationError('country filter is invalid');
    }
    where.country = normalizedCountry;
  }

  return where;
}

function buildSearchClause(search) {
  if (!search) return null;
  const pattern = `%${search}%`;

  return {
    [Op.or]: [
      { name: { [Op.like]: pattern } },
      { studioCode: { [Op.like]: pattern } },
      { email: { [Op.like]: pattern } },
      { phone: { [Op.like]: pattern } },
    ],
  };
}

function sanitizeStudio(studioLike) {
  if (!studioLike) return null;
  const studio = studioLike && typeof studioLike.get === 'function'
    ? studioLike.get({ plain: true })
    : studioLike;

  const safe = {};
  for (const key of STUDIO_SAFE_ATTRIBUTES) {
    safe[key] = studio[key];
  }
  return safe;
}

async function listStudios(options = {}) {
  const pagination = normalizePagination(options);
  const search = normalizeSearch(options.search);
  const filters = normalizeFilters(options.filters || {});
  const searchClause = buildSearchClause(search);

  const where = searchClause
    ? { ...filters, ...searchClause }
    : filters;

  const result = await Studio.findAndCountAll({
    where,
    attributes: STUDIO_SAFE_ATTRIBUTES,
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
    studios: result.rows.map(sanitizeStudio),
  };
}

async function getStudioById(studioId) {
  const normalizedStudioId = parsePositiveInteger(studioId, 'studioId');
  const studio = await Studio.findByPk(normalizedStudioId, {
    attributes: STUDIO_SAFE_ATTRIBUTES,
  });

  return sanitizeStudio(studio);
}

module.exports = {
  listStudios,
  getStudioById,
  sanitizeStudio,
};