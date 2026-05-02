exports.updateReservation = async (req, res) => {
  try {
    const { memberId, equipmentId, salonId, date, time } = req.body;
    if (!memberId || !equipmentId || !salonId || !date || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (isNaN(memberId) || isNaN(equipmentId) || isNaN(salonId)) {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    const reservation = await Reservation.findByPk(req.params.id);
    if (!reservation) return res.sendStatus(404);
    // Validate equipment exists and belongs to salon
    const equipment = await Equipment.findByPk(equipmentId);
    if (!equipment) return res.status(400).json({ error: 'Equipment not found' });
    if (equipment.salonId !== Number(salonId)) return res.status(400).json({ error: 'Equipment does not belong to this salon' });
    if (!['Mat', 'Reformer'].includes(equipment.type)) return res.status(400).json({ error: 'Invalid equipment type' });
    // Validate member exists and is assigned to salon
    const member = await Member.findOne({ where: { id: memberId, isActive: true } });
    if (!member) return res.status(400).json({ error: 'Member not found or inactive' });
    if (!member.assignedSalonIds.includes(Number(salonId))) return res.status(400).json({ error: 'Member not assigned to this salon' });
    // Check slot availability (excluding current reservation)
    const slotConflict = await Reservation.count({
      where: {
        equipmentId,
        date,
        time,
        id: { $ne: reservation.id }
      }
    });
    if (slotConflict > 0) return res.status(400).json({ error: 'Slot not available' });
    // Prevent double booking for member at same time (excluding current reservation)
    const memberDouble = await Reservation.count({
      where: {
        memberId,
        date,
        time,
        id: { $ne: reservation.id }
      }
    });
    if (memberDouble > 0) return res.status(400).json({ error: 'Member already has a reservation at this time' });
    // Update reservation
    reservation.memberId = memberId;
    reservation.equipmentId = equipmentId;
    reservation.salonId = salonId;
    reservation.date = date;
    reservation.time = time;
    await reservation.save();
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
    res.json(formatReservation(enriched));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
const { Reservation, Equipment, Salon, Member, MemberType } = require('../models');
const { Op } = require('sequelize');

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
    time: reservation.time,
    recurrenceGroupId: reservation.recurrenceGroupId,
    recurrenceType: reservation.recurrenceType,
    recurrenceEndDate: reservation.recurrenceEndDate
  };
}

// Helper: check slot availability
async function isSlotAvailable(equipmentId, date, time) {
  const count = await Reservation.count({ where: { equipmentId, date, time } });
  return count === 0;
}

exports.createReservation = async (req, res) => {
  try {
    const { memberId, equipmentId, salonId, date, time, repeatWeekly, recurrenceEndDate } = req.body;
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
    const member = await Member.findOne({ where: { id: memberId, isActive: true }, include: [{ model: MemberType, attributes: ['id', 'isCardBased'] }] });
    if (!member) return res.status(400).json({ error: 'Member not found or inactive' });
    if (!member.assignedSalonIds.includes(Number(salonId))) return res.status(400).json({ error: 'Member not assigned to this salon' });
    // --- Remove remainingLessons check for reservation creation ---
    // --- Recurring reservation logic ---
    if (!repeatWeekly) {
      // Single reservation (legacy behavior)
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
      return res.status(201).json(formatReservation(enriched));
    }
    // --- Weekly recurring reservation ---
    // Calculate dates
    const startDate = new Date(date);
    let endDate;
    if (recurrenceEndDate) {
      endDate = new Date(recurrenceEndDate);
    } else {
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7 * 155); // 156 weeks (3 years)
    }
    // Generate all dates
    const reservationDates = [];
    let current = new Date(startDate);
    while (current <= endDate) {
      reservationDates.push(new Date(current));
      current.setDate(current.getDate() + 7);
    }
    // Check for conflicts for all dates
    for (const d of reservationDates) {
      const dStr = d.toISOString().slice(0, 10);
      const slotAvailable = await isSlotAvailable(equipmentId, dStr, time);
      if (!slotAvailable) {
        return res.status(400).json({ error: `Slot not available for ${dStr} ${time}` });
      }
      const memberDouble = await Reservation.count({ where: { memberId, date: dStr, time } });
      if (memberDouble > 0) {
        return res.status(400).json({ error: `Member already has a reservation at this time for ${dStr} ${time}` });
      }
    }
    // All clear, create all reservations in a transaction
    const { sequelize } = require('../models');
    const recurrenceGroupId = `recurr_${Date.now()}_${Math.floor(Math.random()*10000)}`;
    await sequelize.transaction(async (t) => {
      for (const d of reservationDates) {
        const dStr = d.toISOString().slice(0, 10);
        await Reservation.create({
          memberId,
          equipmentId,
          salonId,
          date: dStr,
          time,
          recurrenceGroupId,
          recurrenceType: 'weekly',
          recurrenceEndDate: endDate.toISOString().slice(0, 10)
        }, { transaction: t });
      }
    });
    // Return all created reservations for this group
    const created = await Reservation.findAll({
      where: { recurrenceGroupId },
      include: [{
        model: Member,
        attributes: ['id', 'name', 'memberTypeId'],
        include: [{
          model: MemberType,
          attributes: ['id', 'name', 'color']
        }]
      }]
    });
    res.status(201).json(created.map(formatReservation));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getReservations = async (req, res) => {
  const onlyMyMembers = req.query.onlyMyMembers === 'true';
  console.log('[DEBUG] req.user.id:', req.user.id);
  console.log('[DEBUG] req.user.role:', req.user.role);
  console.log('[DEBUG] onlyMyMembers query:', onlyMyMembers);
  let where = {};
  let memberWhere = {};
  let filterMode = 'all';
  if (req.user.role === 'instructor') {
    where.salonId = req.user.assignedSalonIds;
    if (onlyMyMembers) {
      memberWhere.assignedInstructorId = req.user.id;
      filterMode = 'onlyMyMembers';
    }
  }
  console.log('[DEBUG] final reservation filter mode:', filterMode);
  const reservations = await Reservation.findAll({
    where,
    include: [{
      model: Member,
      attributes: ['id', 'name', 'memberTypeId', 'assignedInstructorId'],
      where: Object.keys(memberWhere).length ? memberWhere : undefined,
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
  const id = req.params.id;
  const reservation = await Reservation.findByPk(id);
  if (!reservation) return res.sendStatus(404);
  // Instructors can only delete in their assigned salons
  if (req.user.role === 'instructor' && !req.user.assignedSalonIds.includes(reservation.salonId)) {
    return res.sendStatus(403);
  }
  const deleteScope = req.query.deleteScope || 'single';
  console.log('[Reservation Delete] id:', id);
  console.log('[Reservation Delete] scope:', deleteScope);
  console.log('[Reservation Delete] recurrenceGroupId:', reservation.recurrenceGroupId);
  console.log('[Reservation Delete] selected date:', reservation.date);
  if (deleteScope === 'future' && reservation.recurrenceGroupId) {
    // Ensure correct date comparison (date is string YYYY-MM-DD)
    const selectedDate = new Date(reservation.date);
    const dateStr = selectedDate.toISOString().split('T')[0];
    console.log('[DELETE QUERY]');
    console.log('group:', reservation.recurrenceGroupId);
    console.log('date >=', dateStr);
    await Reservation.destroy({
      where: {
        recurrenceGroupId: reservation.recurrenceGroupId,
        date: { [Op.gte]: dateStr }
      }
    });
    return res.sendStatus(204);
  }
  // Default: delete only this reservation
  await reservation.destroy();
  res.sendStatus(204);
};
