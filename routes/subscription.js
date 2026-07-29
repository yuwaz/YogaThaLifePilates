const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getStatus } = require('../controllers/subscriptionController');

const router = express.Router();

router.get('/status', authenticateToken, getStatus);

module.exports = router;