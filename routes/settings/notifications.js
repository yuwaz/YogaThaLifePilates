const express = require('express');
const controller = require('../../controllers/notificationController');
const settingsController = require('../../controllers/notificationSettingsController');
const deviceTokenController = require('../../controllers/deviceTokenController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.staffInbox);
router.get('/unread-count', authorizeRoles(['admin', 'instructor']), controller.staffUnreadCount);
router.post('/:id/read', authorizeRoles(['admin', 'instructor']), controller.staffMarkRead);
router.post('/read-all', authorizeRoles(['admin', 'instructor']), controller.staffMarkAllRead);

// Device token registration (staff: admin + instructor).
router.post('/device', authorizeRoles(['admin', 'instructor']), deviceTokenController.staffRegisterDevice);
router.delete('/device', authorizeRoles(['admin', 'instructor']), deviceTokenController.staffUnregisterDevice);

// Studio notification settings (admin only).
router.get('/settings', authorizeRoles(['admin']), settingsController.getSettings);
router.put('/settings', authorizeRoles(['admin']), settingsController.updateSettings);

module.exports = router;
