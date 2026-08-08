const { SUBSCRIPTION_STATUSES, SUBSCRIPTION_PLANS } = require('../models/studioMetadata');
const {
  EFFECTIVE_ENTITLEMENT_STATUSES,
  isEffectiveEntitlementStatus,
  isValidNormalizedSubscriptionStatus,
  isValidPurchaseIntentStatus,
  isValidProviderBackedPlan,
  isValidSubscriptionEnvironment,
  isValidSubscriptionProvider,
} = require('../models/subscriptionInfrastructureMetadata');

function parseUtcDate(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}

function getSubscriptionStatus(studio) {
  if (!studio || typeof studio.subscriptionStatus !== 'string') {
    return null;
  }

  const status = studio.subscriptionStatus.trim();
  return status === '' ? null : status;
}

function isValidSubscriptionStatus(value) {
  return typeof value === 'string' && SUBSCRIPTION_STATUSES.includes(value);
}

function isValidSubscriptionPlan(value) {
  return typeof value === 'string' && SUBSCRIPTION_PLANS.includes(value);
}

function normalizeSubscriptionPlanInput(value) {
  if (typeof value !== 'string' || !isValidSubscriptionPlan(value)) {
    throw new Error('subscriptionPlan must be one of trial, basic, pro, enterprise, lifetime');
  }

  return value;
}

function normalizeTrialEndsAtInput(value) {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('trialEndsAt must be null or a valid ISO datetime');
  }

  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  if (!isoPattern.test(value)) {
    throw new Error('trialEndsAt must be null or a valid ISO datetime');
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('trialEndsAt must be null or a valid ISO datetime');
  }

  return parsed;
}

function getTrialEndsAtDate(studio) {
  return parseUtcDate(studio ? studio.trialEndsAt : undefined);
}

function isTrialExpired(studio, now = new Date()) {
  if (getSubscriptionStatus(studio) !== 'trial') {
    return false;
  }

  const trialEndsAt = getTrialEndsAtDate(studio);
  if (trialEndsAt === null || trialEndsAt === undefined) {
    return false;
  }

  return now.getTime() > trialEndsAt.getTime();
}

function isSubscriptionActive(studio, now = new Date()) {
  const status = getSubscriptionStatus(studio);
  if (status === 'active') {
    return true;
  }

  if (status !== 'trial') {
    return false;
  }

  const trialEndsAt = getTrialEndsAtDate(studio);
  if (trialEndsAt === undefined) {
    return false;
  }

  if (trialEndsAt === null) {
    return true;
  }

  return now.getTime() <= trialEndsAt.getTime();
}

function calculateRemainingTrialDays(studio, now = new Date()) {
  const trialEndsAt = getTrialEndsAtDate(studio);
  if (trialEndsAt === null) {
    return null;
  }
  if (trialEndsAt === undefined) {
    return null;
  }

  const remainingMs = trialEndsAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

function getSubscriptionState(studio, now = new Date()) {
  const trialEndsAt = getTrialEndsAtDate(studio);
  const subscriptionStatus = getSubscriptionStatus(studio);
  const onTrial = subscriptionStatus === 'trial';
  const trialExpired = isTrialExpired(studio, now);

  return {
    studioId: studio ? studio.id : null,
    studioName: studio ? studio.name : null,
    subscriptionStatus,
    subscriptionPlan: studio && typeof studio.subscriptionPlan === 'string' ? studio.subscriptionPlan : null,
    trialEndsAt,
    onTrial,
    trialExpired,
    daysRemaining: calculateRemainingTrialDays(studio, now),
    onboardingCompleted: Boolean(studio && studio.onboardingCompleted),
    onboardingStep: studio ? studio.onboardingStep : null,
    serverTime: now,
  };
}

function normalizeSubscriptionResponse(studio, now = new Date()) {
  const state = getSubscriptionState(studio, now);
  return {
    subscriptionStatus: state.subscriptionStatus,
    subscriptionPlan: state.subscriptionPlan,
    trialEndsAt: state.trialEndsAt ? state.trialEndsAt.toISOString() : null,
    onTrial: state.onTrial,
    trialExpired: state.trialExpired,
    daysRemaining: state.daysRemaining,
    onboardingCompleted: state.onboardingCompleted,
    onboardingStep: state.onboardingStep,
    serverTime: state.serverTime.toISOString(),
  };
}

function normalizeManagementResponse(studio, now = new Date()) {
  return {
    studioId: studio ? studio.id : null,
    studioName: studio ? studio.name : null,
    subscriptionStatus: studio ? studio.subscriptionStatus : null,
    subscriptionPlan: studio && typeof studio.subscriptionPlan === 'string' ? studio.subscriptionPlan : null,
    trialEndsAt: studio && studio.trialEndsAt ? new Date(studio.trialEndsAt).toISOString() : null,
    onboardingCompleted: Boolean(studio && studio.onboardingCompleted),
    onboardingStep: studio ? studio.onboardingStep : null,
    serverTime: now.toISOString(),
  };
}

module.exports = {
  getSubscriptionState,
  isSubscriptionActive,
  isTrialExpired,
  calculateRemainingTrialDays,
  normalizeSubscriptionResponse,
  normalizeManagementResponse,
  isValidSubscriptionStatus,
  isValidSubscriptionPlan,
  normalizeTrialEndsAtInput,
  normalizeSubscriptionPlanInput,
  isValidSubscriptionProvider,
  isValidSubscriptionEnvironment,
  isValidNormalizedSubscriptionStatus,
  isValidPurchaseIntentStatus,
  isValidProviderBackedPlan,
  isEffectiveEntitlementStatus,
  getEffectiveEntitlementStatuses: () => [...EFFECTIVE_ENTITLEMENT_STATUSES],
};