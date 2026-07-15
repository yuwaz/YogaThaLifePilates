const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const {
  getStudioOnboarding,
  updateStudioOnboarding,
} = require('../../controllers/studioOnboardingController');

const router = express.Router();

router.use(authenticateToken);
router.get('/', getStudioOnboarding);
router.patch('/', updateStudioOnboarding);

module.exports = router;
