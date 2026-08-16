const { Studio, StudioSubscriptionEntitlement, StudioManualSubscriptionOverride } = require('../models');
const { SUBSCRIPTION_STATUSES } = require('../models/studioMetadata');
const {
  NORMALIZED_SUBSCRIPTION_STATUSES,
} = require('../models/subscriptionInfrastructureMetadata');

const ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES = Object.freeze([
  'trialing',
  'active',
  'grace_period',
  'billing_retry',
]);

const NORMALIZED_STATUS_SET = new Set(NORMALIZED_SUBSCRIPTION_STATUSES);
const ENFORCEMENT_OPERATIONAL_SET = new Set(ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES);
const LEGACY_STATUS_SET = new Set(SUBSCRIPTION_STATUSES);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toDateOrNull(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function buildUnavailableDecision() {
  return {
    ok: false,
    checkUnavailable: true,
    code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    operationalAccess: false,
    recoveryAllowed: true,
    decisionSource: null,
    normalizedStatus: null,
    subscriptionStatus: null,
    trialExpired: null,
  };
}

function buildDecision({
  operationalAccess,
  decisionSource,
  normalizedStatus = null,
  subscriptionStatus = null,
  trialExpired = null,
}) {
  return {
    ok: true,
    checkUnavailable: false,
    code: null,
    operationalAccess: Boolean(operationalAccess),
    recoveryAllowed: true,
    decisionSource,
    normalizedStatus,
    subscriptionStatus,
    trialExpired,
  };
}

function buildDeniedManualOverrideDecision(subscriptionStatus = 'unknown') {
  return buildDecision({
    operationalAccess: false,
    decisionSource: 'manual_override',
    normalizedStatus: null,
    subscriptionStatus,
    trialExpired: null,
  });
}

function evaluateEntitlementDecision(entitlement, now = new Date()) {
  const normalizedStatus = normalizeString(entitlement && entitlement.normalizedStatus);
  if (!normalizedStatus || !NORMALIZED_STATUS_SET.has(normalizedStatus)) {
    return buildDecision({
      operationalAccess: false,
      decisionSource: 'entitlement',
      normalizedStatus: 'unknown',
      subscriptionStatus: null,
      trialExpired: null,
    });
  }

  if (normalizedStatus === 'cancelled') {
    const currentPeriodEnd = toDateOrNull(entitlement && entitlement.currentPeriodEnd);
    const hasAuthoritativeFuturePeriodEnd = Boolean(
      currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()
    );

    return buildDecision({
      operationalAccess: hasAuthoritativeFuturePeriodEnd,
      decisionSource: 'entitlement',
      normalizedStatus,
      subscriptionStatus: null,
      trialExpired: null,
    });
  }

  return buildDecision({
    operationalAccess: ENFORCEMENT_OPERATIONAL_SET.has(normalizedStatus),
    decisionSource: 'entitlement',
    normalizedStatus,
    subscriptionStatus: null,
    trialExpired: null,
  });
}

function evaluateLegacyStudioDecision(studio, now = new Date()) {
  const subscriptionStatus = normalizeString(studio && studio.subscriptionStatus);
  if (!subscriptionStatus) {
    return buildDecision({
      operationalAccess: false,
      decisionSource: 'legacy_studio',
      normalizedStatus: null,
      subscriptionStatus: 'unknown',
      trialExpired: null,
    });
  }

  if (subscriptionStatus === 'active') {
    return buildDecision({
      operationalAccess: true,
      decisionSource: 'legacy_studio',
      normalizedStatus: null,
      subscriptionStatus,
      trialExpired: null,
    });
  }

  if (subscriptionStatus === 'trial') {
    const trialEndsAt = toDateOrNull(studio.trialEndsAt);
    if (!trialEndsAt) {
      return buildDecision({
        operationalAccess: false,
        decisionSource: 'legacy_studio',
        normalizedStatus: null,
        subscriptionStatus,
        trialExpired: null,
      });
    }

    const trialExpired = now.getTime() > trialEndsAt.getTime();
    return buildDecision({
      operationalAccess: !trialExpired,
      decisionSource: 'legacy_studio',
      normalizedStatus: null,
      subscriptionStatus,
      trialExpired,
    });
  }

  if (subscriptionStatus === 'past_due' || subscriptionStatus === 'suspended' || subscriptionStatus === 'cancelled') {
    return buildDecision({
      operationalAccess: false,
      decisionSource: 'legacy_studio',
      normalizedStatus: null,
      subscriptionStatus,
      trialExpired: null,
    });
  }

  return buildDecision({
    operationalAccess: false,
    decisionSource: 'legacy_studio',
    normalizedStatus: null,
    subscriptionStatus,
    trialExpired: null,
  });
}

function evaluateManualOverrideDecision(overrideRecord, baseStudio, now = new Date()) {
  const subscriptionStatus = normalizeString(overrideRecord && overrideRecord.subscriptionStatus);
  if (!subscriptionStatus || !LEGACY_STATUS_SET.has(subscriptionStatus)) {
    return buildDeniedManualOverrideDecision('unknown');
  }

  if (subscriptionStatus === 'active') {
    return buildDecision({
      operationalAccess: true,
      decisionSource: 'manual_override',
      normalizedStatus: null,
      subscriptionStatus,
      trialExpired: null,
    });
  }

  if (subscriptionStatus === 'trial') {
    const trialEndsAt = toDateOrNull(overrideRecord && overrideRecord.expiresAt)
      || toDateOrNull(baseStudio && baseStudio.trialEndsAt);

    if (!trialEndsAt) {
      return buildDecision({
        operationalAccess: false,
        decisionSource: 'manual_override',
        normalizedStatus: null,
        subscriptionStatus,
        trialExpired: null,
      });
    }

    const trialExpired = now.getTime() > trialEndsAt.getTime();
    return buildDecision({
      operationalAccess: !trialExpired,
      decisionSource: 'manual_override',
      normalizedStatus: null,
      subscriptionStatus,
      trialExpired,
    });
  }

  return buildDecision({
    operationalAccess: false,
    decisionSource: 'manual_override',
    normalizedStatus: null,
    subscriptionStatus,
    trialExpired: null,
  });
}

function parseManualOverrideTemporalState(overrideRecord, now = new Date()) {
  const effectiveFrom = toDateOrNull(overrideRecord && overrideRecord.effectiveFrom);
  if (!effectiveFrom) {
    return { invalid: true, isEffectiveNow: false, isExpired: false, isFuture: false };
  }

  const rawExpiresAt = overrideRecord && overrideRecord.expiresAt;
  const hasExpiresAt = !(rawExpiresAt === null || typeof rawExpiresAt === 'undefined' || rawExpiresAt === '');
  const expiresAt = hasExpiresAt ? toDateOrNull(rawExpiresAt) : null;
  if (hasExpiresAt && !expiresAt) {
    return { invalid: true, isEffectiveNow: false, isExpired: false, isFuture: false };
  }

  const nowMs = now.getTime();
  const effectiveMs = effectiveFrom.getTime();
  if (effectiveMs > nowMs) {
    return { invalid: false, isEffectiveNow: false, isExpired: false, isFuture: true };
  }

  if (expiresAt && expiresAt.getTime() <= nowMs) {
    return { invalid: false, isEffectiveNow: false, isExpired: true, isFuture: false };
  }

  return { invalid: false, isEffectiveNow: true, isExpired: false, isFuture: false };
}

function buildLegacyFallbackStudioWithOverrideBaseline(studio, overrideRecord) {
  if (!overrideRecord) {
    return studio;
  }

  const fallbackStatus = normalizeString(overrideRecord.previousSubscriptionStatus);
  if (!fallbackStatus || !LEGACY_STATUS_SET.has(fallbackStatus)) {
    return null;
  }

  return {
    subscriptionStatus: fallbackStatus,
    trialEndsAt: toDateOrNull(overrideRecord.previousTrialEndsAt),
  };
}

async function resolveSubscriptionAccessDecision({
  studioId,
  now = new Date(),
  dependencies = {},
} = {}) {
  if (!Number.isInteger(studioId) || studioId <= 0) {
    return buildUnavailableDecision();
  }

  const StudioModel = dependencies.StudioModel || Studio;
  const EntitlementModel = dependencies.EntitlementModel || StudioSubscriptionEntitlement;
  const ManualOverrideModel = dependencies.ManualOverrideModel || StudioManualSubscriptionOverride;

  try {
    const studio = await StudioModel.findByPk(studioId, {
      attributes: ['id', 'subscriptionStatus', 'trialEndsAt'],
    });

    if (!studio) {
      return buildUnavailableDecision();
    }

    const manualOverride = await ManualOverrideModel.findOne({
      where: {
        studioId,
        revokedAt: null,
      },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });

    if (manualOverride) {
      const temporalState = parseManualOverrideTemporalState(manualOverride, now);
      if (temporalState.invalid) {
        return buildDeniedManualOverrideDecision('unknown');
      }

      if (temporalState.isEffectiveNow) {
        return evaluateManualOverrideDecision(manualOverride, studio, now);
      }
    }

    const entitlement = await EntitlementModel.findOne({
      where: { studioId },
      order: [
        ['providerEventTime', 'DESC'],
        ['lastVerifiedAt', 'DESC'],
        ['updatedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });

    if (entitlement) {
      return evaluateEntitlementDecision(entitlement, now);
    }

    if (manualOverride) {
      const legacyFallbackStudio = buildLegacyFallbackStudioWithOverrideBaseline(studio, manualOverride);
      if (legacyFallbackStudio) {
        return evaluateLegacyStudioDecision(legacyFallbackStudio, now);
      }

      return buildDeniedManualOverrideDecision('unknown');
    }

    return evaluateLegacyStudioDecision(studio, now);
  } catch (error) {
    return buildUnavailableDecision();
  }
}

module.exports = {
  ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES,
  resolveSubscriptionAccessDecision,
};