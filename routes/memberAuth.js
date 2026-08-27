const express = require('express');
const controller = require('../controllers/memberActivationController');
const memberAuthController = require('../controllers/memberAuthController');
const { authenticateMember } = require('../middleware/memberAuth');

const router = express.Router();

router.post('/activate', controller.activateMember);
router.post('/login', memberAuthController.login);
router.get('/me', authenticateMember, memberAuthController.getMe);
router.post('/select-membership', authenticateMember, memberAuthController.selectMembership);

module.exports = router;
