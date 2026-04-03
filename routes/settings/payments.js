const express = require('express');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const { deletePayment } = require('../../controllers/paymentMethodController');

const router = express.Router();

router.use(authenticateToken);

router.delete('/:id', authorizeRoles(['admin']), deletePayment);

module.exports = router;
