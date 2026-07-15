const { Studio } = require('../models');
const {
  isSupportedOnboardingStep,
  getNextOnboardingStep,
} = require('../models/studioMetadata');
const { validateOnboardingTransitionRequirements } = require('../services/onboardingRequirements');

function hasForbiddenStudioSelector(req) {
  const hasBodyStudioId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'studioId');
  const hasQueryStudioId = req.query && Object.prototype.hasOwnProperty.call(req.query, 'studioId');
  const hasParamStudioId = req.params && Object.prototype.hasOwnProperty.call(req.params, 'studioId');
  const headers = req.headers || {};
  const hasHeaderStudioId = Object.prototype.hasOwnProperty.call(headers, 'studioid')
    || Object.prototype.hasOwnProperty.call(headers, 'studio-id')
    || Object.prototype.hasOwnProperty.call(headers, 'x-studio-id');

  return hasBodyStudioId || hasQueryStudioId || hasParamStudioId || hasHeaderStudioId;
}

function toOnboardingResponse(studio) {
  return {
    studioId: studio.id,
    onboardingCompleted: Boolean(studio.onboardingCompleted),
    onboardingStep: studio.onboardingStep,
  };
}

async function getScopedStudio(req) {
  const studioId = req.user && req.user.studioId;
  if (!Number.isInteger(studioId) || studioId <= 0) {
    return null;
  }

  const studio = await Studio.findOne({ where: { id: studioId } });
  return studio;
}

exports.getStudioOnboarding = async (req, res) => {
  try {
    const studio = await getScopedStudio(req);
    if (!studio) return res.status(404).json({ error: 'Not found' });
    return res.json(toOnboardingResponse(studio));
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.updateStudioOnboarding = async (req, res) => {
  try {
    if (hasForbiddenStudioSelector(req)) {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'onboardingCompleted')) {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const studio = await getScopedStudio(req);
    if (!studio) return res.status(404).json({ error: 'Not found' });

    const hasStep = req.body && Object.prototype.hasOwnProperty.call(req.body, 'onboardingStep');
    if (!hasStep) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (typeof req.body.onboardingStep !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const requestedStep = req.body.onboardingStep.trim();
    if (!isSupportedOnboardingStep(requestedStep)) {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const currentStep = studio.onboardingStep;
    if (!isSupportedOnboardingStep(currentStep)) {
      return res.status(500).json({ error: 'Server error' });
    }

    const isCurrentCompleted = currentStep === 'completed' || Boolean(studio.onboardingCompleted);
    if (isCurrentCompleted) {
      if (requestedStep !== 'completed') {
        return res.status(400).json({ error: 'Invalid field types' });
      }
    } else if (requestedStep !== currentStep) {
      const nextStep = getNextOnboardingStep(currentStep);
      if (requestedStep !== nextStep) {
        return res.status(400).json({ error: 'Invalid field types' });
      }

      const requirementResult = await validateOnboardingTransitionRequirements({
        studioId: studio.id,
        currentStep,
        requestedStep,
      });

      if (!requirementResult.ok) {
        return res.status(400).json({
          error: 'Onboarding requirement not met',
          requiredStep: requirementResult.requiredStep,
          missingRequirement: requirementResult.missingRequirement,
        });
      }
    }

    studio.onboardingStep = requestedStep;
    studio.onboardingCompleted = requestedStep === 'completed';
    await studio.save();

    return res.json(toOnboardingResponse(studio));
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};
