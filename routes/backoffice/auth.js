const express = require('express');
const platformAuthController = require('../../controllers/platformAuthController');
const { authenticatePlatformAdmin } = require('../../middleware/platformAuth');

const router = express.Router();

router.post('/login', platformAuthController.login);
router.get('/me', authenticatePlatformAdmin, platformAuthController.me);

module.exports = router;