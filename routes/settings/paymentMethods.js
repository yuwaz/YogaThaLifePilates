const express = require('express');
const controller = require('../../controllers/paymentMethodController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getPaymentMethods);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getPaymentMethod);
router.post('/', authorizePagePermission('settings'), controller.createPaymentMethod);
router.put('/:id', authorizePagePermission('settings'), controller.updatePaymentMethod);
router.delete('/:id', authorizePagePermission('settings'), controller.deletePaymentMethod);

module.exports = router;
