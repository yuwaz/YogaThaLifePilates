const crypto = require('crypto');
const { PlatformAuditLog } = require('../models');

const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'jwt',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'cookie',
  'setcookie',
  'secret',
  'privatekey',
  'providercredentials',
  'purchasetoken',
  'linkedpurchasetoken',
  'signedpayload',
  'signedtransactioninfo',
  'signedrenewalinfo',
  'rawpayloadjson',
  'rawapiresponsejson',
]);

function createAuditError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createAuditError('PLATFORM_AUDIT_VALIDATION_ERROR', `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function normalizeOptionalString(value, fieldName, maxLength = 2000) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw createAuditError('PLATFORM_AUDIT_VALIDATION_ERROR', `${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > maxLength) {
    throw createAuditError('PLATFORM_AUDIT_VALIDATION_ERROR', `${fieldName} exceeds max length`);
  }

  return normalized;
}

function toSafeSnapshotValue(value, pathParts = []) {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => toSafeSnapshotValue(entry, [...pathParts, String(index)]));
  }

  if (Object.prototype.toString.call(value) === '[object Object]') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (FORBIDDEN_SNAPSHOT_KEYS.has(normalizedKey)) {
        throw createAuditError(
          'PLATFORM_AUDIT_FORBIDDEN_DATA',
          `Snapshot contains forbidden field: ${[...pathParts, key].join('.')}`
        );
      }

      output[key] = toSafeSnapshotValue(nestedValue, [...pathParts, key]);
    }
    return output;
  }

  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return value;
  }

  return String(value);
}

function generateEventId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function toSafeAuditLogPayload(auditLogLike) {
  const auditLog = auditLogLike && typeof auditLogLike.get === 'function'
    ? auditLogLike.get({ plain: true })
    : auditLogLike;

  return {
    id: auditLog.id,
    eventId: auditLog.eventId,
    actorPlatformAdminId: auditLog.actorPlatformAdminId,
    actionType: auditLog.actionType,
    targetType: auditLog.targetType,
    targetId: auditLog.targetId,
    studioId: auditLog.studioId,
    reason: auditLog.reason,
    requestId: auditLog.requestId,
    ip: auditLog.ip,
    userAgent: auditLog.userAgent,
    beforeSnapshot: auditLog.beforeSnapshot,
    afterSnapshot: auditLog.afterSnapshot,
    createdAt: auditLog.createdAt,
    updatedAt: auditLog.updatedAt,
  };
}

async function recordPlatformAuditEvent({
  actorPlatformAdminId,
  actionType,
  targetType,
  targetId,
  studioId,
  reason,
  requestId,
  ip,
  userAgent,
  beforeSnapshot,
  afterSnapshot,
  transaction,
}) {
  const normalizedActorId = parsePositiveInteger(actorPlatformAdminId, 'actorPlatformAdminId');
  const normalizedActionType = normalizeOptionalString(actionType, 'actionType', 255);
  if (!normalizedActionType) {
    throw createAuditError('PLATFORM_AUDIT_VALIDATION_ERROR', 'actionType is required');
  }

  const normalizedStudioId = studioId === undefined || studioId === null
    ? null
    : parsePositiveInteger(studioId, 'studioId');

  const created = await PlatformAuditLog.create({
    eventId: generateEventId(),
    actorPlatformAdminId: normalizedActorId,
    actionType: normalizedActionType,
    targetType: normalizeOptionalString(targetType, 'targetType', 255),
    targetId: normalizeOptionalString(targetId, 'targetId', 255),
    studioId: normalizedStudioId,
    reason: normalizeOptionalString(reason, 'reason', 5000),
    requestId: normalizeOptionalString(requestId, 'requestId', 255),
    ip: normalizeOptionalString(ip, 'ip', 255),
    userAgent: normalizeOptionalString(userAgent, 'userAgent', 2048),
    beforeSnapshot: toSafeSnapshotValue(beforeSnapshot),
    afterSnapshot: toSafeSnapshotValue(afterSnapshot),
  }, { transaction });

  return toSafeAuditLogPayload(created);
}

module.exports = {
  recordPlatformAuditEvent,
  toSafeSnapshotValue,
  toSafeAuditLogPayload,
};