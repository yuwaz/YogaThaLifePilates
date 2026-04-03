const express = require('express');
const controller = require('../../controllers/equipmentController');
const { authenticateToken, authorizeRoles, authorizeInstructorSalon } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getEquipment);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getEquipmentById);
router.post('/', authorizeRoles(['admin']), controller.createEquipment);
router.put('/:id', authorizeRoles(['admin']), controller.updateEquipment);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteEquipment);

module.exports = router;
