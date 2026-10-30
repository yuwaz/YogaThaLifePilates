const express = require('express');
const controller = require('../controllers/notificationController');
const deviceTokenController = require('../controllers/deviceTokenController');
const { authenticateMember } = require('../middleware/memberAuth');

const router = express.Router();

router.use(authenticateMember);
router.get('/', controller.memberInbox);
router.get('/unread-count', controller.memberUnreadCount);
router.post('/:id/read', controller.memberMarkRead);
router.post('/read-all', controller.memberMarkAllRead);

// Device token registration (member global token).
router.post('/device', deviceTokenController.memberRegisterDevice);
router.delete('/device', deviceTokenController.memberUnregisterDevice);

module.exports = router;
