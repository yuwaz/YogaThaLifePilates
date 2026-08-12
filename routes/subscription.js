const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
	getStatus,
	getCatalog,
	createApplePurchaseIntent,
	createGooglePlayPurchaseIntent,
	verifyGooglePlayPurchase,
	verifyApplePurchase,
	restoreAppleSubscription,
	restoreGooglePlaySubscription,
} = require('../controllers/subscriptionController');
const {
	handleAppleServerNotification,
} = require('../controllers/appleNotificationController');
const {
	handleGooglePlayRtdnNotification,
} = require('../controllers/googlePlayRtdnController');

const router = express.Router();

router.get('/status', authenticateToken, getStatus);
router.get('/catalog', authenticateToken, getCatalog);
router.post('/apple/purchase-intent', authenticateToken, createApplePurchaseIntent);
router.post('/google-play/purchase-intent', authenticateToken, createGooglePlayPurchaseIntent);
router.post('/google-play/verify-purchase', authenticateToken, verifyGooglePlayPurchase);
router.post('/apple/verify-purchase', authenticateToken, verifyApplePurchase);
router.post('/apple/restore', authenticateToken, restoreAppleSubscription);
router.post('/google-play/restore', authenticateToken, restoreGooglePlaySubscription);
router.post('/apple/notifications', handleAppleServerNotification);
router.post('/google-play/notifications', handleGooglePlayRtdnNotification);

module.exports = router;