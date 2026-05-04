const express = require('express');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const paymentController = require('../../controllers/paymentController');

const router = express.Router();

router.use(authenticateToken);

// GET all payments
router.get('/', authorizeRoles(['admin', 'instructor']), paymentController.getPayments);
// POST create payment
const { authorizeActionPermission } = require('../../middleware/auth');
// Allow users with either 'payments:create' or 'payments' permission
router.post('/', authorizeActionPermission('payments:create'), paymentController.createPayment);
// PUT update payment
router.put('/:id', authorizeRoles(['admin']), paymentController.updatePayment);
// DELETE payment
router.delete('/:id', authorizeRoles(['admin']), paymentController.deletePayment);

module.exports = router;
