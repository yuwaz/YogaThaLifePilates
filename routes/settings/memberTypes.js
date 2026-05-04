const express = require('express');
const controller = require('../../controllers/memberTypeController');
const { authenticateToken, authorizeRoles, authorizePagePermission } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getMemberTypes);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getMemberType);
router.post('/', authorizePagePermission('settings'), controller.createMemberType);
router.put('/:id', authorizePagePermission('settings'), controller.updateMemberType);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteMemberType);

module.exports = router;
