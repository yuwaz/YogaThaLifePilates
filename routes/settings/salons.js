const express = require('express');
const controller = require('../../controllers/salonController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getSalons);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getSalon);
router.post('/', authorizeRoles(['admin']), controller.createSalon);
router.put('/:id', authorizeRoles(['admin']), controller.updateSalon);
router.delete('/:id', authorizeRoles(['admin']), controller.deleteSalon);

module.exports = router;
