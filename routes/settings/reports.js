const express = require('express');
const controller = require('../../controllers/reportsController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getReports);

module.exports = router;
