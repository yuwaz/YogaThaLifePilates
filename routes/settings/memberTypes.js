const express = require('express');
const controller = require('../../controllers/memberTypeController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getMemberTypes);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getMemberType);
router.post('/', authorizeRoles(['admin']), controller.createMemberType);
router.put('/:id', authorizeRoles(['admin']), controller.updateMemberType);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteMemberType);

module.exports = router;
