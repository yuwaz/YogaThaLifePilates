const express = require('express');
const controller = require('../../controllers/paymentMethodController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getPaymentMethods);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getPaymentMethod);
router.post('/', authorizeRoles(['admin']), controller.createPaymentMethod);
router.put('/:id', authorizeRoles(['admin']), controller.updatePaymentMethod);
router.delete('/:id', authorizeRoles(['admin']), controller.deletePaymentMethod);

module.exports = router;
