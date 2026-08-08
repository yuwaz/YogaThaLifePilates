const express = require('express');
const { authenticatePlatformAdmin } = require('../../middleware/platformAuth');
const backofficeOpsController = require('../../controllers/backofficeOpsController');

const router = express.Router();

router.use(authenticatePlatformAdmin);
router.get('/summary', backofficeOpsController.getPlatformSummary);

module.exports = router;