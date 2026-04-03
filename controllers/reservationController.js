const { Reservation, Equipment, Salon, Member } = require('../models');

// Helper: check slot availability
async function isSlotAvailable(equipmentId, date, time) {
  const count = await Reservation.count({ where: { equipmentId, date, time } });
  return count === 0;
}

exports.createReservation = async (req, res) => {
  try {
    const { memberId, equipmentId, salonId, date, time } = req.body;
    // Validate equipment exists and belongs to salon
    const equipment = await Equipment.findByPk(equipmentId);
    if (!equipment) return res.status(400).json({ error: 'Equipment not found' });
    if (equipment.salonId !== Number(salonId)) return res.status(400).json({ error: 'Equipment does not belong to this salon' });
    if (!['Mat', 'Reformer'].includes(equipment.type)) return res.status(400).json({ error: 'Invalid equipment type' });
    // Validate member exists and is assigned to salon
    const member = await Member.findByPk(memberId);
    if (!member) return res.status(400).json({ error: 'Member not found' });
    if (!member.assignedSalonIds.includes(Number(salonId))) return res.status(400).json({ error: 'Member not assigned to this salon' });
    // Check member has enough lessons
    if (member.remainingLessons <= 0) return res.status(400).json({ error: 'No remaining lessons' });
    // Check slot availability
    const available = await isSlotAvailable(equipmentId, date, time);
    if (!available) return res.status(400).json({ error: 'Slot not available' });
    // Create reservation
    const reservation = await Reservation.create({ memberId, equipmentId, salonId, date, time });
    // Decrement lesson count
    member.remainingLessons = Number(member.remainingLessons) - 1;
    await member.save();
    res.status(201).json(reservation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getReservations = async (req, res) => {
  const where = {};
  // Instructors only see their assigned salons
  if (req.user.role === 'instructor') {
    where.salonId = req.user.assignedSalonIds;
  }
  const reservations = await Reservation.findAll({ where });
  res.json(reservations);
};

exports.getReservation = async (req, res) => {
  const reservation = await Reservation.findByPk(req.params.id);
  if (!reservation) return res.sendStatus(404);
  // Instructors can only access their assigned salons
  if (req.user.role === 'instructor' && !req.user.assignedSalonIds.includes(reservation.salonId)) {
    return res.sendStatus(403);
  }
  res.json(reservation);
};

exports.deleteReservation = async (req, res) => {
  const reservation = await Reservation.findByPk(req.params.id);
  if (!reservation) return res.sendStatus(404);
  // Instructors can only delete in their assigned salons
  if (req.user.role === 'instructor' && !req.user.assignedSalonIds.includes(reservation.salonId)) {
    return res.sendStatus(403);
  }
  await reservation.destroy();
  res.sendStatus(204);
};
