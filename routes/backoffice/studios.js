const express = require('express');
const { authenticatePlatformAdmin } = require('../../middleware/platformAuth');
const backofficeStudioController = require('../../controllers/backofficeStudioController');

const router = express.Router();

router.use(authenticatePlatformAdmin);

router.get('/', backofficeStudioController.listStudios);
router.post('/:studioId/suspend', backofficeStudioController.suspendStudio);
router.post('/:studioId/reactivate', backofficeStudioController.reactivateStudio);
router.post('/:studioId/subscription/manual-override', backofficeStudioController.setManualSubscriptionOverride);
router.post('/:studioId/subscription/manual-override/revoke', backofficeStudioController.revokeManualSubscriptionOverride);
router.get('/:studioId/users/:userId', backofficeStudioController.getStudioUser);
router.get('/:studioId/users', backofficeStudioController.listStudioUsers);
router.get('/:studioId/subscription', backofficeStudioController.getStudioSubscriptionOverview);
router.get('/:studioId', backofficeStudioController.getStudio);

module.exports = router;