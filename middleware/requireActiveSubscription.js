const { Studio } = require('../models');

function sendSubscriptionRequired(res, studio) {
  return res.status(403).json({
    error: 'SUBSCRIPTION_REQUIRED',
    subscriptionStatus: studio && typeof studio.subscriptionStatus !== 'undefined'
      ? studio.subscriptionStatus
      : null,
    trialEndsAt: studio && typeof studio.trialEndsAt !== 'undefined'
      ? studio.trialEndsAt
      : null,
    message: 'Studio subscription is not active.',
  });
}

function toComparableDate(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}

async function requireActiveSubscription(req, res, next) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.sendStatus(403);
    }

    req.studio = studio;

    const status = typeof studio.subscriptionStatus === 'string'
      ? studio.subscriptionStatus.trim()
      : '';
    const trialEndsAt = toComparableDate(studio.trialEndsAt);
    const now = new Date();

    if (status === 'active') {
      return next();
    }

    if (status === 'trial') {
      if (trialEndsAt === undefined) {
        return sendSubscriptionRequired(res, studio);
      }
      if (trialEndsAt === null || now.getTime() <= trialEndsAt.getTime()) {
        return next();
      }
      return sendSubscriptionRequired(res, studio);
    }

    if (status === 'past_due' || status === 'suspended' || status === 'cancelled') {
      return sendSubscriptionRequired(res, studio);
    }

    return sendSubscriptionRequired(res, studio);
  } catch (err) {
    return res.sendStatus(403);
  }
}

module.exports = requireActiveSubscription;