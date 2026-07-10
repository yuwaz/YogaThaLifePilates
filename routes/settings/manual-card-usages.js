const express = require('express');
const controller = require('../../controllers/manualCardUsageController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getManualCardUsages);
router.post('/', authorizePagePermission('settings'), controller.createManualCardUsage);
router.put('/:id', authorizePagePermission('settings'), controller.updateManualCardUsage);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteManualCardUsage);

module.exports = router;
