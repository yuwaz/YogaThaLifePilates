const { Studio } = require('../models');
const subscriptionService = require('../services/subscriptionService');

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

    const now = new Date();
    if (subscriptionService.isSubscriptionActive(studio, now)) {
      return next();
    }

    return sendSubscriptionRequired(res, studio);
  } catch (err) {
    return res.sendStatus(403);
  }
}

module.exports = requireActiveSubscription;