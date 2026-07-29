const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const {
  getManagementStatus,
  updateManagementStatus,
} = require('../../controllers/subscriptionController');

const router = express.Router();

router.use(authenticateToken);

router.get('/', getManagementStatus);
router.patch('/', updateManagementStatus);

module.exports = router;