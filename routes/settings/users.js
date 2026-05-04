const express = require('express');
const controller = require('../../controllers/userController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizePagePermission('settings'), controller.getUsers);
router.get('/:id', authorizeRoles(['admin']), controller.getUser);
router.post('/', authorizePagePermission('settings'), controller.createUser);
router.put('/:id', authorizePagePermission('settings'), controller.updateUser);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteUser);

module.exports = router;
