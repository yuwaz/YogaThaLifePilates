const express = require('express');
const { authenticatePlatformAdmin } = require('../../middleware/platformAuth');
const backofficeOpsController = require('../../controllers/backofficeOpsController');

const router = express.Router();

router.use(authenticatePlatformAdmin);
router.get('/summary', backofficeOpsController.getPlatformSummary);
router.get('/audit-logs', backofficeOpsController.listPlatformAuditLogs);

module.exports = router;