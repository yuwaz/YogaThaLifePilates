const express = require('express');
const controller = require('../../controllers/userController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin']), controller.getUsers);
router.get('/:id', authorizeRoles(['admin']), controller.getUser);
router.post('/', authorizeRoles(['admin']), controller.createUser);
router.put('/:id', authorizeRoles(['admin']), controller.updateUser);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteUser);

module.exports = router;
