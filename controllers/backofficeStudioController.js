const backofficeStudioService = require('../services/backofficeStudioService');
const backofficeUserService = require('../services/backofficeUserService');
const backofficeSubscriptionService = require('../services/backofficeSubscriptionService');

function sendInvalidRequest(res) {
  return res.status(400).json({ error: 'BACKOFFICE_INVALID_REQUEST' });
}

function sendNotFound(res) {
  return res.status(404).json({ error: 'BACKOFFICE_NOT_FOUND' });
}

function sendInternalError(res) {
  return res.status(500).json({ error: 'BACKOFFICE_INTERNAL_ERROR' });
}

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('INVALID_POSITIVE_INTEGER');
  }
  return parsed;
}

function parseBooleanQuery(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new Error('INVALID_BOOLEAN_QUERY');
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('INVALID_BOOLEAN_QUERY');
}

function toPagination(page, limit, total) {
  const safeTotal = Number(total || 0);
  const safeLimit = Number(limit || 1);
  return {
    page,
    limit,
    total: safeTotal,
    totalPages: safeLimit > 0 ? Math.ceil(safeTotal / safeLimit) : 0,
  };
}

function mapServiceErrorToResponse(res, err) {
  if (err && err.code === 'BACKOFFICE_VALIDATION_ERROR') {
    return sendInvalidRequest(res);
  }

  return sendInternalError(res);
}

async function listStudios(req, res) {
  try {
    const page = parsePositiveInt(req.query.page) || 1;
    const requestedLimit = parsePositiveInt(req.query.limit);
    const options = {
      search: req.query.search,
      offset: (page - 1) * (requestedLimit || 25),
    };

    if (requestedLimit !== null) {
      options.limit = requestedLimit;
    }

    const filters = {};
    if (req.query.subscriptionStatus !== undefined) filters.subscriptionStatus = req.query.subscriptionStatus;
    if (req.query.subscriptionPlan !== undefined) filters.subscriptionPlan = req.query.subscriptionPlan;
    if (req.query.onboardingCompleted !== undefined) {
      filters.onboardingCompleted = parseBooleanQuery(req.query.onboardingCompleted);
    }
    if (req.query.country !== undefined) filters.country = req.query.country;
    options.filters = filters;

    const result = await backofficeStudioService.listStudios(options);
    return res.status(200).json({
      items: result.studios,
      pagination: toPagination(page, result.limit, result.total),
    });
  } catch (err) {
    if (err && (err.message === 'INVALID_POSITIVE_INTEGER' || err.message === 'INVALID_BOOLEAN_QUERY')) {
      return sendInvalidRequest(res);
    }
    return mapServiceErrorToResponse(res, err);
  }
}

async function getStudio(req, res) {
  try {
    const studio = await backofficeStudioService.getStudioById(req.params.studioId);
    if (!studio) {
      return sendNotFound(res);
    }
    return res.status(200).json({ studio });
  } catch (err) {
    return mapServiceErrorToResponse(res, err);
  }
}

async function listStudioUsers(req, res) {
  try {
    const studioId = parsePositiveInt(req.params.studioId);
    const page = parsePositiveInt(req.query.page) || 1;
    const requestedLimit = parsePositiveInt(req.query.limit);

    const options = {
      role: req.query.role,
      search: req.query.search,
      offset: (page - 1) * (requestedLimit || 25),
    };
    if (requestedLimit !== null) {
      options.limit = requestedLimit;
    }

    const result = await backofficeUserService.listStudioUsers(studioId, options);
    return res.status(200).json({
      items: result.users,
      pagination: toPagination(page, result.limit, result.total),
    });
  } catch (err) {
    if (err && err.message === 'INVALID_POSITIVE_INTEGER') {
      return sendInvalidRequest(res);
    }
    return mapServiceErrorToResponse(res, err);
  }
}

async function getStudioUser(req, res) {
  try {
    const studioId = parsePositiveInt(req.params.studioId);
    const userId = parsePositiveInt(req.params.userId);
    const user = await backofficeUserService.getStudioUserById(studioId, userId);
    if (!user) {
      return sendNotFound(res);
    }
    return res.status(200).json({ user });
  } catch (err) {
    if (err && err.message === 'INVALID_POSITIVE_INTEGER') {
      return sendInvalidRequest(res);
    }
    return mapServiceErrorToResponse(res, err);
  }
}

async function getStudioSubscriptionOverview(req, res) {
  try {
    const studioId = parsePositiveInt(req.params.studioId);
    const subscription = await backofficeSubscriptionService.getStudioSubscriptionOverview(studioId);
    if (!subscription) {
      return sendNotFound(res);
    }
    return res.status(200).json({ subscription });
  } catch (err) {
    if (err && err.message === 'INVALID_POSITIVE_INTEGER') {
      return sendInvalidRequest(res);
    }
    return mapServiceErrorToResponse(res, err);
  }
}

module.exports = {
  listStudios,
  getStudio,
  listStudioUsers,
  getStudioUser,
  getStudioSubscriptionOverview,
};