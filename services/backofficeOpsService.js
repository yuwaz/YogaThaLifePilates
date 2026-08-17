const { Op } = require('sequelize');
const { Studio, User, PlatformAdmin, PlatformAuditLog } = require('../models');

const AUDIT_LOG_FORBIDDEN_KEYS = new Set([
  'password', 'passwordhash', 'jwt', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'authorization', 'cookie', 'setcookie', 'platformjwtsecret', 'jwttoken', 'tenantjwt',
  'applesignedpayload', 'applejws', 'jws', 'signedpayload', 'signedtransactioninfo', 'signedrenewalinfo',
  'purchasetoken', 'providerreceipt', 'serviceaccountcredentials', 'privatekey',
  'secret', 'secrets', 'mfasecret', 'credential', 'credentials', 'headers', 'rawheaders',
  'requestheaders', 'body', 'requestbody', 'rawbody', 'rawrequest',
]);

function createValidationError(message) {
  const error = new Error(message);
  error.code = 'BACKOFFICE_VALIDATION_ERROR';
  return error;
}

function parsePositiveInteger(value, fieldName, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalFilter(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 255) {
    throw createValidationError(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseOptionalDate(value, fieldName) {
  const normalized = parseOptionalFilter(value, fieldName);
  if (normalized === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(normalized)) {
    throw createValidationError(`${fieldName} must be a valid ISO date/time`);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw createValidationError(`${fieldName} must be a valid ISO date/time`);
  }
  return parsed;
}

function normalizeAuditKey(key) {
  return String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function sanitizeAuditValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry));
  if (Object.prototype.toString.call(value) === '[object Object]') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (AUDIT_LOG_FORBIDDEN_KEYS.has(normalizeAuditKey(key))) continue;
      output[key] = sanitizeAuditValue(nestedValue);
    }
    return output;
  }
  if (value instanceof Date) return value.toISOString();
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return undefined;
}

function mapAuditLogToDto(auditLog) {
  const plain = auditLog.get({ plain: true });
  const actor = plain.PlatformAdmin || null;
  const studio = plain.Studio || null;
  return {
    id: plain.id,
    eventId: plain.eventId,
    actorPlatformAdminId: plain.actorPlatformAdminId,
    actor: actor ? { id: actor.id, email: actor.email, status: actor.status } : null,
    actionType: plain.actionType,
    targetType: plain.targetType,
    targetId: plain.targetId,
    studioId: plain.studioId,
    studio: studio ? { id: studio.id, name: studio.name, studioCode: studio.studioCode } : null,
    reason: plain.reason,
    requestId: plain.requestId,
    ip: plain.ip,
    userAgent: plain.userAgent,
    beforeSnapshot: sanitizeAuditValue(plain.beforeSnapshot),
    afterSnapshot: sanitizeAuditValue(plain.afterSnapshot),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function listPlatformAuditLogs(query = {}) {
  const page = parsePositiveInteger(query.page, 'page', 1);
  const limit = parsePositiveInteger(query.limit, 'limit', 25);
  if (limit > 100) throw createValidationError('limit must not exceed 100');

  const where = {};
  const studioId = parseOptionalFilter(query.studioId, 'studioId');
  const actorPlatformAdminId = parseOptionalFilter(query.actorPlatformAdminId, 'actorPlatformAdminId');
  const actionType = parseOptionalFilter(query.action, 'action');
  const targetType = parseOptionalFilter(query.targetType, 'targetType');
  const from = parseOptionalDate(query.from, 'from');
  const to = parseOptionalDate(query.to, 'to');

  if (studioId !== undefined) where.studioId = studioId;
  if (actorPlatformAdminId !== undefined) where.actorPlatformAdminId = actorPlatformAdminId;
  if (actionType !== undefined) where.actionType = actionType;
  if (targetType !== undefined) where.targetType = targetType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = from;
    if (to) where.createdAt[Op.lt] = to;
  }

  const result = await PlatformAuditLog.findAndCountAll({
    where,
    attributes: [
      'id', 'eventId', 'actorPlatformAdminId', 'actionType', 'targetType', 'targetId',
      'studioId', 'reason', 'requestId', 'ip', 'userAgent', 'beforeSnapshot', 'afterSnapshot',
      'createdAt', 'updatedAt',
    ],
    include: [
      { model: PlatformAdmin, attributes: ['id', 'email', 'status'], required: false },
    ],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  return {
    items: result.rows.map(mapAuditLogToDto),
    pagination: {
      page,
      limit,
      total: Number(result.count || 0),
      totalPages: result.count > 0 ? Math.ceil(result.count / limit) : 0,
    },
  };
}

function groupCountRows(rows, keyField, valueField) {
  const grouped = {};
  for (const row of rows || []) {
    const key = String(row[keyField]);
    grouped[key] = Number(row[valueField]);
  }
  return grouped;
}

async function getPlatformSummary() {
  const [
    totalStudios,
    activeStudios,
    trialStudios,
    suspendedStudios,
    cancelledStudios,
    onboardingCompletedCount,
    onboardingIncompleteCount,
    totalTenantUsers,
    totalStudioAdmins,
    totalInstructors,
    studiosByPlanRows,
  ] = await Promise.all([
    Studio.count(),
    Studio.count({ where: { subscriptionStatus: 'active' } }),
    Studio.count({ where: { subscriptionStatus: 'trial' } }),
    Studio.count({ where: { subscriptionStatus: 'suspended' } }),
    Studio.count({ where: { subscriptionStatus: 'cancelled' } }),
    Studio.count({ where: { onboardingCompleted: true } }),
    Studio.count({ where: { onboardingCompleted: false } }),
    User.count(),
    User.count({ where: { role: 'admin' } }),
    User.count({ where: { role: 'instructor' } }),
    Studio.findAll({
      attributes: [
        'subscriptionPlan',
        [Studio.sequelize.fn('COUNT', Studio.sequelize.col('subscriptionPlan')), 'count'],
      ],
      group: ['subscriptionPlan'],
      raw: true,
    }),
  ]);

  return {
    totalStudios: Number(totalStudios || 0),
    activeStudios: Number(activeStudios || 0),
    trialStudios: Number(trialStudios || 0),
    suspendedStudios: Number(suspendedStudios || 0),
    cancelledStudios: Number(cancelledStudios || 0),
    studiosByPlan: groupCountRows(studiosByPlanRows, 'subscriptionPlan', 'count'),
    onboardingCompletedCount: Number(onboardingCompletedCount || 0),
    onboardingIncompleteCount: Number(onboardingIncompleteCount || 0),
    totalTenantUsers: Number(totalTenantUsers || 0),
    totalStudioAdmins: Number(totalStudioAdmins || 0),
    totalInstructors: Number(totalInstructors || 0),
  };
}

module.exports = {
  getPlatformSummary,
  listPlatformAuditLogs,
};