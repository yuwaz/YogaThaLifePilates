const express = require('express');
const { authenticateToken, authorizeRoles, authorizeActionPermission } = require('../../middleware/auth');
const expenseController = require('../../controllers/expenseController');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), expenseController.getExpenses);
router.get('/:id', authorizeRoles(['admin', 'instructor']), expenseController.getExpense);
router.post('/', authorizeActionPermission('payments:create'), expenseController.createExpense);
router.put('/:id', authorizeRoles(['admin']), expenseController.updateExpense);
router.delete('/:id', authorizeRoles(['admin']), expenseController.deleteExpense);

module.exports = router;