const express = require('express');
const controller = require('../../controllers/reservationController');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', authorizeRoles(['admin', 'instructor']), controller.getReservations);
router.get('/:id', authorizeRoles(['admin', 'instructor']), controller.getReservation);
router.post('/', authorizeRoles(['admin', 'instructor']), controller.createReservation);
router.delete('/:id', authorizeRoles(['admin', 'instructor']), controller.deleteReservation);

module.exports = router;
