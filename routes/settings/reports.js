const express = require('express');
const controller = require('../../controllers/reportsController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getReports);

module.exports = router;
