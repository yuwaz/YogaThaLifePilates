const express = require('express');
const controller = require('../../controllers/equipmentController');
const { authenticateToken, authorizeRoles, authorizeInstructorSalon, authorizePagePermission } = require('../../middleware/auth');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');

const router = express.Router();

router.use(authenticateToken);
router.use(requireActiveSubscription);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getEquipment);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getEquipmentById);
router.post('/', authorizePagePermission('settings'), controller.createEquipment);
router.put('/:id', authorizePagePermission('settings'), controller.updateEquipment);
router.delete('/:id', authorizePagePermission('settings'), controller.deleteEquipment);

module.exports = router;
