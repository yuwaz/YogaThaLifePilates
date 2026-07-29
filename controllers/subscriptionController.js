const { Studio } = require('../models');

function toUtcDate(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function calculateDaysRemaining(now, trialEndsAt) {
  if (trialEndsAt === null) {
    return null;
  }

  const remainingMs = trialEndsAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

async function getStatus(req, res) {
  try {
    const studioId = req && req.user ? req.user.studioId : undefined;
    if (!Number.isInteger(studioId) || studioId <= 0) {
      return res.sendStatus(403);
    }

    const studio = await Studio.findByPk(studioId);
    if (!studio) {
      return res.status(404).json({ error: 'Not found' });
    }

    const now = new Date();
    const trialEndsAt = toUtcDate(studio.trialEndsAt);
    const subscriptionStatus = typeof studio.subscriptionStatus === 'string'
      ? studio.subscriptionStatus
      : null;
    const onTrial = subscriptionStatus === 'trial';
    const trialExpired = onTrial && trialEndsAt !== null && now.getTime() > trialEndsAt.getTime();

    return res.json({
      subscriptionStatus,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      onTrial,
      trialExpired,
      daysRemaining: calculateDaysRemaining(now, trialEndsAt),
      onboardingCompleted: Boolean(studio.onboardingCompleted),
      onboardingStep: studio.onboardingStep,
      serverTime: now.toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  getStatus,
};