function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePositiveIntegerId(value, fieldName = 'id') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw createHttpError(400, `${fieldName} must be a positive integer`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw createHttpError(400, `${fieldName} must be a positive integer`);
    }

    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw createHttpError(400, `${fieldName} must be a positive integer`);
    }
    return parsed;
  }

  throw createHttpError(400, `${fieldName} must be a positive integer`);
}

function getAuthenticatedStudioId(req) {
  const studioId = req && req.user ? req.user.studioId : undefined;
  if (!Number.isInteger(studioId) || studioId <= 0) {
    throw createHttpError(403, 'Forbidden');
  }
  return studioId;
}

function withStudioWhere(req, additionalWhere = {}) {
  if (additionalWhere === null || typeof additionalWhere === 'undefined') {
    additionalWhere = {};
  }

  if (typeof additionalWhere !== 'object' || Array.isArray(additionalWhere)) {
    throw createHttpError(400, 'Invalid where object');
  }

  const studioId = getAuthenticatedStudioId(req);
  return {
    ...additionalWhere,
    studioId,
  };
}

function assertSameStudio(record, req) {
  if (!record) {
    throw createHttpError(404, 'Not found');
  }

  const studioId = getAuthenticatedStudioId(req);
  if (!Number.isInteger(record.studioId) || record.studioId !== studioId) {
    throw createHttpError(404, 'Not found');
  }

  return true;
}

function requireTenantContext(req, res, next) {
  try {
    getAuthenticatedStudioId(req);
    return next();
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message || 'Forbidden' });
  }
}

module.exports = {
  getAuthenticatedStudioId,
  withStudioWhere,
  assertSameStudio,
  parsePositiveIntegerId,
  requireTenantContext,
};