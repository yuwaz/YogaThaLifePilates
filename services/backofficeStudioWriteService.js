const {
  sequelize,
  PlatformAdmin,
  Studio,
  StudioManualSubscriptionOverride,
} = require('../models');
const { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES } = require('../models/studioMetadata');
const { recordPlatformAuditEvent } = require('./platformAuditService');

function createWriteError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', `${fieldName} must be a positive integer`, 400);
  }
  return parsed;
}

function normalizeRequiredReason(value, fieldName = 'reason') {
  if (typeof value !== 'string') {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', `${fieldName} is required`, 400);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', `${fieldName} is required`, 400);
  }
  if (normalized.length > 5000) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', `${fieldName} exceeds max length`, 400);
  }
  return normalized;
}

function normalizeOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', `${fieldName} must be a valid datetime`, 400);
  }
  return date;
}

function normalizeSubscriptionPlan(value) {
  if (typeof value !== 'string' || !SUBSCRIPTION_PLANS.includes(value)) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', 'subscriptionPlan is invalid', 400);
  }
  return value;
}

function normalizeSubscriptionStatus(value) {
  if (typeof value !== 'string' || !SUBSCRIPTION_STATUSES.includes(value)) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', 'subscriptionStatus is invalid', 400);
  }
  return value;
}

function normalizeRequestMetadata(metadata = {}) {
  const normalized = {};
  if (metadata && typeof metadata === 'object') {
    if (typeof metadata.requestId === 'string' && metadata.requestId.trim()) {
      normalized.requestId = metadata.requestId.trim().slice(0, 255);
    }
    if (typeof metadata.ip === 'string' && metadata.ip.trim()) {
      normalized.ip = metadata.ip.trim().slice(0, 255);
    }
    if (typeof metadata.userAgent === 'string' && metadata.userAgent.trim()) {
      normalized.userAgent = metadata.userAgent.trim().slice(0, 2048);
    }
  }
  return normalized;
}

async function assertActorIsActive(actorPlatformAdminId, transaction) {
  const actorId = parsePositiveInteger(actorPlatformAdminId, 'actorPlatformAdminId');
  const actor = await PlatformAdmin.findByPk(actorId, {
    attributes: ['id', 'status'],
    transaction,
  });

  if (!actor || actor.status !== 'active') {
    throw createWriteError('BACKOFFICE_ACCESS_DENIED', 'Platform admin is not allowed', 403);
  }

  return actorId;
}

async function loadStudioOrThrow(studioId, transaction) {
  const normalizedStudioId = parsePositiveInteger(studioId, 'studioId');
  const studio = await Studio.findByPk(normalizedStudioId, { transaction });
  if (!studio) {
    throw createWriteError('BACKOFFICE_NOT_FOUND', 'Studio not found', 404);
  }
  return studio;
}

function toStudioWriteSnapshot(studio) {
  return {
    id: studio.id,
    operationalStatus: studio.operationalStatus,
    subscriptionStatus: studio.subscriptionStatus,
    subscriptionPlan: studio.subscriptionPlan,
    trialEndsAt: studio.trialEndsAt,
  };
}

function sanitizeStudioWriteResult(studioLike) {
  const studio = studioLike && typeof studioLike.get === 'function'
    ? studioLike.get({ plain: true })
    : studioLike;

  return {
    id: studio.id,
    name: studio.name,
    studioCode: studio.studioCode,
    operationalStatus: studio.operationalStatus,
    subscriptionStatus: studio.subscriptionStatus,
    subscriptionPlan: studio.subscriptionPlan,
    trialEndsAt: studio.trialEndsAt,
    updatedAt: studio.updatedAt,
  };
}

function sanitizeManualOverride(overrideLike) {
  if (!overrideLike) return null;
  const override = overrideLike && typeof overrideLike.get === 'function'
    ? overrideLike.get({ plain: true })
    : overrideLike;

  return {
    id: override.id,
    studioId: override.studioId,
    subscriptionPlan: override.subscriptionPlan,
    subscriptionStatus: override.subscriptionStatus,
    effectiveFrom: override.effectiveFrom || null,
    expiresAt: override.expiresAt || null,
    reason: override.reason,
    createdByPlatformAdminId: override.createdByPlatformAdminId,
    revokedAt: override.revokedAt || null,
    revokedByPlatformAdminId: override.revokedByPlatformAdminId || null,
    revokeReason: override.revokeReason || null,
    createdAt: override.createdAt || null,
    updatedAt: override.updatedAt || null,
  };
}

async function suspendStudio({ actorPlatformAdminId, studioId, reason, requestMetadata }) {
  const normalizedReason = normalizeRequiredReason(reason);
  const metadata = normalizeRequestMetadata(requestMetadata);

  return sequelize.transaction(async (transaction) => {
    const actorId = await assertActorIsActive(actorPlatformAdminId, transaction);
    const studio = await loadStudioOrThrow(studioId, transaction);

    if (studio.operationalStatus === 'suspended') {
      throw createWriteError('BACKOFFICE_CONFLICT', 'Studio is already suspended', 409);
    }

    const beforeSnapshot = toStudioWriteSnapshot(studio);
    studio.operationalStatus = 'suspended';
    await studio.save({ fields: ['operationalStatus'], transaction });
    const afterSnapshot = toStudioWriteSnapshot(studio);

    await recordPlatformAuditEvent({
      actorPlatformAdminId: actorId,
      actionType: 'studio.suspend',
      targetType: 'studio',
      targetId: String(studio.id),
      studioId: studio.id,
      reason: normalizedReason,
      requestId: metadata.requestId,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      beforeSnapshot,
      afterSnapshot,
      transaction,
    });

    return {
      studio: sanitizeStudioWriteResult(studio),
    };
  });
}

async function reactivateStudio({ actorPlatformAdminId, studioId, reason, requestMetadata }) {
  const normalizedReason = normalizeRequiredReason(reason);
  const metadata = normalizeRequestMetadata(requestMetadata);

  return sequelize.transaction(async (transaction) => {
    const actorId = await assertActorIsActive(actorPlatformAdminId, transaction);
    const studio = await loadStudioOrThrow(studioId, transaction);

    if (studio.operationalStatus === 'active') {
      throw createWriteError('BACKOFFICE_CONFLICT', 'Studio is already active', 409);
    }

    const beforeSnapshot = toStudioWriteSnapshot(studio);
    studio.operationalStatus = 'active';
    await studio.save({ fields: ['operationalStatus'], transaction });
    const afterSnapshot = toStudioWriteSnapshot(studio);

    await recordPlatformAuditEvent({
      actorPlatformAdminId: actorId,
      actionType: 'studio.reactivate',
      targetType: 'studio',
      targetId: String(studio.id),
      studioId: studio.id,
      reason: normalizedReason,
      requestId: metadata.requestId,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      beforeSnapshot,
      afterSnapshot,
      transaction,
    });

    return {
      studio: sanitizeStudioWriteResult(studio),
    };
  });
}

async function setManualSubscriptionOverride({
  actorPlatformAdminId,
  studioId,
  subscriptionPlan,
  subscriptionStatus,
  effectiveFrom,
  expiresAt,
  reason,
  requestMetadata,
}) {
  const normalizedReason = normalizeRequiredReason(reason);
  const normalizedPlan = normalizeSubscriptionPlan(subscriptionPlan);
  const normalizedStatus = normalizeSubscriptionStatus(subscriptionStatus);
  const normalizedEffectiveFrom = normalizeOptionalDate(effectiveFrom, 'effectiveFrom') || new Date();
  const normalizedExpiresAt = normalizeOptionalDate(expiresAt, 'expiresAt');
  if (normalizedExpiresAt && normalizedExpiresAt.getTime() <= normalizedEffectiveFrom.getTime()) {
    throw createWriteError('BACKOFFICE_INVALID_REQUEST', 'expiresAt must be after effectiveFrom', 400);
  }
  const metadata = normalizeRequestMetadata(requestMetadata);

  return sequelize.transaction(async (transaction) => {
    const actorId = await assertActorIsActive(actorPlatformAdminId, transaction);
    const studio = await loadStudioOrThrow(studioId, transaction);

    const existingActiveOverride = await StudioManualSubscriptionOverride.findOne({
      where: {
        studioId: studio.id,
        revokedAt: null,
      },
      order: [['createdAt', 'DESC']],
      transaction,
    });

    if (existingActiveOverride) {
      throw createWriteError('BACKOFFICE_CONFLICT', 'An active manual override already exists for this studio', 409);
    }

    const beforeSnapshot = {
      studio: toStudioWriteSnapshot(studio),
      activeManualOverride: null,
    };

    const override = await StudioManualSubscriptionOverride.create({
      studioId: studio.id,
      subscriptionPlan: normalizedPlan,
      subscriptionStatus: normalizedStatus,
      effectiveFrom: normalizedEffectiveFrom,
      expiresAt: normalizedExpiresAt,
      reason: normalizedReason,
      createdByPlatformAdminId: actorId,
      previousSubscriptionPlan: studio.subscriptionPlan,
      previousSubscriptionStatus: studio.subscriptionStatus,
      previousTrialEndsAt: studio.trialEndsAt,
    }, { transaction });

    studio.subscriptionPlan = normalizedPlan;
    studio.subscriptionStatus = normalizedStatus;
    await studio.save({ fields: ['subscriptionPlan', 'subscriptionStatus'], transaction });

    const afterSnapshot = {
      studio: toStudioWriteSnapshot(studio),
      activeManualOverride: sanitizeManualOverride(override),
    };

    await recordPlatformAuditEvent({
      actorPlatformAdminId: actorId,
      actionType: 'studio.subscription_override.set',
      targetType: 'studio',
      targetId: String(studio.id),
      studioId: studio.id,
      reason: normalizedReason,
      requestId: metadata.requestId,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      beforeSnapshot,
      afterSnapshot,
      transaction,
    });

    return {
      studio: sanitizeStudioWriteResult(studio),
      manualOverride: sanitizeManualOverride(override),
    };
  });
}

async function revokeManualSubscriptionOverride({
  actorPlatformAdminId,
  studioId,
  reason,
  requestMetadata,
}) {
  const normalizedReason = normalizeRequiredReason(reason);
  const metadata = normalizeRequestMetadata(requestMetadata);

  return sequelize.transaction(async (transaction) => {
    const actorId = await assertActorIsActive(actorPlatformAdminId, transaction);
    const studio = await loadStudioOrThrow(studioId, transaction);

    const activeOverride = await StudioManualSubscriptionOverride.findOne({
      where: {
        studioId: studio.id,
        revokedAt: null,
      },
      order: [['createdAt', 'DESC']],
      transaction,
    });

    if (!activeOverride) {
      throw createWriteError('BACKOFFICE_CONFLICT', 'No active manual override found for this studio', 409);
    }

    const beforeSnapshot = {
      studio: toStudioWriteSnapshot(studio),
      activeManualOverride: sanitizeManualOverride(activeOverride),
    };

    activeOverride.revokedAt = new Date();
    activeOverride.revokedByPlatformAdminId = actorId;
    activeOverride.revokeReason = normalizedReason;
    await activeOverride.save({ fields: ['revokedAt', 'revokedByPlatformAdminId', 'revokeReason'], transaction });

    const studioFieldsToRestore = [];
    if (activeOverride.previousSubscriptionPlan && activeOverride.previousSubscriptionPlan !== studio.subscriptionPlan) {
      studio.subscriptionPlan = activeOverride.previousSubscriptionPlan;
      studioFieldsToRestore.push('subscriptionPlan');
    }
    if (activeOverride.previousSubscriptionStatus && activeOverride.previousSubscriptionStatus !== studio.subscriptionStatus) {
      studio.subscriptionStatus = activeOverride.previousSubscriptionStatus;
      studioFieldsToRestore.push('subscriptionStatus');
    }

    const previousTrialEndsAtIso = activeOverride.previousTrialEndsAt ? new Date(activeOverride.previousTrialEndsAt).toISOString() : null;
    const currentTrialEndsAtIso = studio.trialEndsAt ? new Date(studio.trialEndsAt).toISOString() : null;
    if (previousTrialEndsAtIso !== currentTrialEndsAtIso) {
      studio.trialEndsAt = activeOverride.previousTrialEndsAt || null;
      studioFieldsToRestore.push('trialEndsAt');
    }

    if (studioFieldsToRestore.length > 0) {
      await studio.save({ fields: studioFieldsToRestore, transaction });
    }

    const afterSnapshot = {
      studio: toStudioWriteSnapshot(studio),
      revokedManualOverride: sanitizeManualOverride(activeOverride),
    };

    await recordPlatformAuditEvent({
      actorPlatformAdminId: actorId,
      actionType: 'studio.subscription_override.revoke',
      targetType: 'studio',
      targetId: String(studio.id),
      studioId: studio.id,
      reason: normalizedReason,
      requestId: metadata.requestId,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      beforeSnapshot,
      afterSnapshot,
      transaction,
    });

    return {
      studio: sanitizeStudioWriteResult(studio),
      manualOverride: sanitizeManualOverride(activeOverride),
    };
  });
}

module.exports = {
  suspendStudio,
  reactivateStudio,
  setManualSubscriptionOverride,
  revokeManualSubscriptionOverride,
};