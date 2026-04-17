const { Reservation, Equipment, Salon, Member, MemberType } = require('../models');

// Helper to format enriched reservation
function formatReservation(reservation) {
  if (!reservation) return null;
  const member = reservation.Member || {};
  const memberType = (member.MemberType) || {};
  return {
    id: reservation.id,
    salonId: reservation.salonId,
    equipmentId: reservation.equipmentId,
    memberId: member.id,
    memberName: member.name,
    memberTypeId: member.memberTypeId,
    memberTypeName: memberType.name,
    memberTypeColor: memberType.color,
    date: reservation.date,
    time: reservation.time
  };
}

// Helper: check slot availability
async function isSlotAvailable(equipmentId, date, time) {
  const count = await Reservation.count({ where: { equipmentId, date, time } });
  return count === 0;
}

exports.createReservation = async (req, res) => {
  try {
    const { memberId, equipmentId, salonId, date, time } = req.body;
    if (!memberId || !equipmentId || !salonId || !date || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (isNaN(memberId) || isNaN(equipmentId) || isNaN(salonId)) {
      return res.status(400).json({ error: 'Invalid field types' });
    }
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
    // Check slot availability (prevent double booking)
    const available = await isSlotAvailable(equipmentId, date, time);
    if (!available) return res.status(400).json({ error: 'Slot not available' });
    // Prevent double booking for member at same time
    const memberDouble = await Reservation.count({ where: { memberId, date, time } });
    if (memberDouble > 0) return res.status(400).json({ error: 'Member already has a reservation at this time' });
    // Create reservation
    const reservation = await Reservation.create({ memberId, equipmentId, salonId, date, time });
    // Fetch enriched reservation for response
    const enriched = await Reservation.findByPk(reservation.id, {
      include: [{
        model: Member,
        attributes: ['id', 'name', 'memberTypeId'],
        include: [{
          model: MemberType,
          attributes: ['id', 'name', 'color']
        }]
      }]
    });
    // Do NOT decrement lesson count here
    res.status(201).json(formatReservation(enriched));
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
  const reservations = await Reservation.findAll({
    where,
    include: [{
      model: Member,
      attributes: ['id', 'name', 'memberTypeId'],
      include: [{
        model: MemberType,
        attributes: ['id', 'name', 'color']
      }]
    }]
  });
  res.json(reservations.map(formatReservation));
};

exports.getReservation = async (req, res) => {
  const reservation = await Reservation.findByPk(req.params.id, {
    include: [{
      model: Member,
      attributes: ['id', 'name', 'memberTypeId'],
      include: [{
        model: MemberType,
        attributes: ['id', 'name', 'color']
      }]
    }]
  });
  if (!reservation) return res.sendStatus(404);
  // Instructors can only access their assigned salons
  if (req.user.role === 'instructor' && !req.user.assignedSalonIds.includes(reservation.salonId)) {
    return res.sendStatus(403);
  }
  res.json(formatReservation(reservation));
}

exports.deleteReservation = async (req, res) => {
  const reservation = await Reservation.findByPk(req.params.id);
  if (!reservation) return res.sendStatus(404);
  // Instructors can only delete in their assigned salons
  if (req.user.role === 'instructor' && !req.user.assignedSalonIds.includes(reservation.salonId)) {
    return res.sendStatus(403);
  }
  await reservation.destroy();
  // Do NOT change lesson count on delete
  res.sendStatus(204);
};
