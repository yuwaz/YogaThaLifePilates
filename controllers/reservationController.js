exports.updateReservation = async (req, res) => {
  try {
    const { memberId, equipmentId, salonId, date, time, repeatWeekly, updateScope } = req.body;
    const id = req.params.id;
    // Debug logs
    const reservation = await Reservation.findByPk(id);
    console.log('[Reservation Update] id', id);
    console.log('[Reservation Update] updateScope', updateScope);
    console.log('[Reservation Update] repeatWeekly', repeatWeekly);
    console.log('[Reservation Update] recurrenceGroupId', reservation ? reservation.recurrenceGroupId : null);

    if (!memberId || !equipmentId || !salonId || !date || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (isNaN(memberId) || isNaN(equipmentId) || isNaN(salonId)) {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (!hasAllowedStartMinute(time)) {
      return res.status(400).json({ error: 'Invalid time. Allowed start minutes are 00, 15, 30, 45' });
    }
    if (!reservation) return res.sendStatus(404);

    // If single reservation and repeatWeekly === true, convert to weekly recurring
    if (!reservation.recurrenceGroupId && repeatWeekly === true) {
      const hasDuplicateSelectedDate = await hasMemberDateReservation(memberId, date, {
        excludeReservationId: reservation.id,
      });
      if (hasDuplicateSelectedDate) {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
      }

      // Update selected reservation fields
      reservation.memberId = memberId;
      reservation.equipmentId = equipmentId;
      reservation.salonId = salonId;
      reservation.date = date;
      reservation.time = time;

      // Generate recurrenceGroupId
      const recurrenceGroupId = `recurr_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      reservation.recurrenceGroupId = recurrenceGroupId;
      reservation.recurrenceType = 'weekly';

      // Calculate 156 weeks (3 years)
      const startDate = new Date(date);
      const reservationDates = [];
      for (let i = 1; i < 156; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + 7 * i);
        reservationDates.push(new Date(d));
      }
      const endDate = reservationDates.length > 0 ? reservationDates[reservationDates.length - 1] : startDate;
      reservation.recurrenceEndDate = endDate.toISOString().slice(0, 10);

      // Check for conflicts for all future dates
      for (const d of reservationDates) {
        const dStr = d.toISOString().slice(0, 10);
        const hasDuplicateDate = await hasMemberDateReservation(memberId, dStr);
        if (hasDuplicateDate) {
          return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
        }
        const equipmentOverlap = await hasEquipmentOverlap(equipmentId, dStr, time);
        if (equipmentOverlap) {
          return res.status(400).json({ error: `Slot not available for ${dStr} ${time}` });
        }
        const memberOverlap = await hasMemberOverlap(memberId, dStr, time);
        if (memberOverlap) {
          return res.status(400).json({ error: `Member already has a reservation at this time for ${dStr} ${time}` });
        }
      }

      // Transaction: update selected, create others
      const { sequelize } = require('../models');
      await sequelize.transaction(async (t) => {
        await reservation.save({ transaction: t });
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
      return res.json(created.map(formatReservation));
    }

    // Validate equipment exists and belongs to salon
    const equipment = await Equipment.findByPk(equipmentId);
    if (!equipment) return res.status(400).json({ error: 'Equipment not found' });
    if (equipment.salonId !== Number(salonId)) return res.status(400).json({ error: 'Equipment does not belong to this salon' });
    if (!['Mat', 'Reformer'].includes(equipment.type)) return res.status(400).json({ error: 'Invalid equipment type' });
    // Validate member exists and is assigned to salon
    const member = await Member.findOne({ where: { id: memberId, isActive: true } });
    if (!member) return res.status(400).json({ error: 'Member not found or inactive' });
    if (!member.assignedSalonIds.includes(Number(salonId))) return res.status(400).json({ error: 'Member not assigned to this salon' });

    // Default: update only selected reservation
    if (!updateScope || updateScope === 'single' || !reservation.recurrenceGroupId) {
      const hasDuplicateDate = await hasMemberDateReservation(memberId, date, {
        excludeReservationId: reservation.id,
      });
      if (hasDuplicateDate) {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
      }

      const availableEquipment = await findAvailableEquipment(salonId, date, time, {
        excludeReservationId: reservation.id,
        preferredEquipmentId: equipmentId,
        equipmentType: equipment.type,
      });
      if (!availableEquipment) {
        return res.status(409).json({ error: 'Seçilen saat için uygun ekipman bulunamadı' });
      }

      const memberOverlap = await hasMemberOverlap(memberId, date, time, { excludeReservationId: reservation.id });
      if (memberOverlap) return res.status(400).json({ error: 'Member already has a reservation at this time' });
      // Update reservation
      reservation.memberId = memberId;
      reservation.equipmentId = availableEquipment.id;
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
      return res.json(formatReservation(enriched));
    }

    // updateScope === 'future' and reservation has recurrenceGroupId
    // Update all future reservations in the group (date >= selected)
    const { Op } = require('sequelize');
    const selectedDate = new Date(reservation.date);
    const dateStr = selectedDate.toISOString().split('T')[0];
    const targetReservations = await Reservation.findAll({
      where: {
        recurrenceGroupId: reservation.recurrenceGroupId,
        date: { [Op.gte]: dateStr }
      },
      attributes: ['id', 'date']
    });

    for (const target of targetReservations) {
      const hasDuplicateDate = await hasMemberDateReservation(memberId, target.date, {
        excludeRecurrenceGroupId: reservation.recurrenceGroupId,
      });
      if (hasDuplicateDate) {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
      }

      const equipmentOverlap = await hasEquipmentOverlap(equipmentId, target.date, time, {
        excludeRecurrenceGroupId: reservation.recurrenceGroupId
      });
      if (equipmentOverlap) return res.status(400).json({ error: 'Slot not available' });

      const memberOverlap = await hasMemberOverlap(memberId, target.date, time, {
        excludeRecurrenceGroupId: reservation.recurrenceGroupId
      });
      if (memberOverlap) return res.status(400).json({ error: 'Member already has a reservation at this time' });
    }

    // Update all future reservations (including selected)
    const { sequelize } = require('../models');
    await sequelize.transaction(async (t) => {
      await Reservation.update(
        {
          memberId,
          equipmentId,
          salonId,
          time
        },
        {
          where: {
            recurrenceGroupId: reservation.recurrenceGroupId,
            date: { [Op.gte]: dateStr }
          },
          transaction: t
        }
      );
    });
    // Return all updated reservations in the group (future)
    const updated = await Reservation.findAll({
      where: {
        recurrenceGroupId: reservation.recurrenceGroupId,
        date: { [Op.gte]: dateStr }
      },
      include: [{
        model: Member,
        attributes: ['id', 'name', 'memberTypeId'],
        include: [{
          model: MemberType,
          attributes: ['id', 'name', 'color']
        }]
      }]
    });
    return res.json(updated.map(formatReservation));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
const { Reservation, Equipment, Salon, Member, MemberType, Attendance } = require('../models');
const { Op } = require('sequelize');

const FIXED_DURATION_MINUTES = 45;
const ALLOWED_START_MINUTES = new Set([0, 15, 30, 45]);

function parseTimeToMinutes(timeValue) {
  if (typeof timeValue !== 'string') return null;
  const parts = timeValue.trim().split(':');
  if (parts.length < 2) return null;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = parts.length >= 3 ? Number(parts[2]) : 0;

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;
  if (seconds < 0 || seconds > 59) return null;

  return (hours * 60) + minutes;
}

function hasAllowedStartMinute(timeValue) {
  const minutes = parseTimeToMinutes(timeValue);
  if (minutes === null) return false;
  return ALLOWED_START_MINUTES.has(minutes % 60);
}

function intervalsOverlap(existingStart, existingEnd, candidateStart, candidateEnd) {
  return existingStart < candidateEnd && existingEnd > candidateStart;
}

async function hasEquipmentOverlap(equipmentId, date, time, options = {}) {
  const { excludeReservationId, excludeRecurrenceGroupId } = options;
  const where = { equipmentId, date };
  if (excludeReservationId !== undefined && excludeReservationId !== null) {
    where.id = { [Op.ne]: excludeReservationId };
  }
  if (excludeRecurrenceGroupId) {
    where.recurrenceGroupId = { [Op.ne]: excludeRecurrenceGroupId };
  }

  const candidateStart = parseTimeToMinutes(time);
  if (candidateStart === null) return true;
  const candidateEnd = candidateStart + FIXED_DURATION_MINUTES;

  const existingReservations = await Reservation.findAll({ where, attributes: ['id', 'time'] });
  for (const existing of existingReservations) {
    const existingStart = parseTimeToMinutes(existing.time);
    if (existingStart === null) return true;
    const existingEnd = existingStart + FIXED_DURATION_MINUTES;
    if (intervalsOverlap(existingStart, existingEnd, candidateStart, candidateEnd)) {
      return true;
    }
  }
  return false;
}

async function hasMemberOverlap(memberId, date, time, options = {}) {
  const { excludeReservationId, excludeRecurrenceGroupId } = options;
  const where = { memberId, date };
  if (excludeReservationId !== undefined && excludeReservationId !== null) {
    where.id = { [Op.ne]: excludeReservationId };
  }
  if (excludeRecurrenceGroupId) {
    where[Op.or] = [
      { recurrenceGroupId: { [Op.ne]: excludeRecurrenceGroupId } },
      { recurrenceGroupId: { [Op.is]: null } },
    ];
  }

  const candidateStart = parseTimeToMinutes(time);
  if (candidateStart === null) return true;
  const candidateEnd = candidateStart + FIXED_DURATION_MINUTES;

  const existingReservations = await Reservation.findAll({ where, attributes: ['id', 'time'] });
  for (const existing of existingReservations) {
    const existingStart = parseTimeToMinutes(existing.time);
    if (existingStart === null) return true;
    const existingEnd = existingStart + FIXED_DURATION_MINUTES;
    if (intervalsOverlap(existingStart, existingEnd, candidateStart, candidateEnd)) {
      return true;
    }
  }
  return false;
}

async function hasMemberDateReservation(memberId, date, options = {}) {
  const { excludeReservationId, excludeRecurrenceGroupId } = options;
  const where = { memberId, date };

  if (excludeReservationId !== undefined && excludeReservationId !== null) {
    where.id = { [Op.ne]: excludeReservationId };
  }
  if (excludeRecurrenceGroupId) {
    where.recurrenceGroupId = { [Op.ne]: excludeRecurrenceGroupId };
  }

  const existing = await Reservation.findOne({ where, attributes: ['id'] });
  return !!existing;
}

async function findAvailableEquipment(salonId, date, time, options = {}) {
  const { excludeReservationId, preferredEquipmentId, equipmentType } = options;
  const equipments = await Equipment.findAll({
    where: {
      salonId: Number(salonId),
      type: equipmentType,
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });

  if (!equipments.length) return null;

  const prioritized = [];
  if (preferredEquipmentId !== undefined && preferredEquipmentId !== null) {
    const preferred = equipments.find((eq) => eq.id === Number(preferredEquipmentId));
    if (preferred) prioritized.push(preferred);
  }

  for (const eq of equipments) {
    if (!prioritized.some((picked) => picked.id === eq.id)) {
      prioritized.push(eq);
    }
  }

  const candidateStart = parseTimeToMinutes(time);
  if (candidateStart === null) return null;
  const candidateEnd = candidateStart + FIXED_DURATION_MINUTES;

  const candidateIds = prioritized.map((eq) => eq.id);
  const reservationWhere = {
    date,
    salonId: Number(salonId),
    equipmentId: { [Op.in]: candidateIds },
  };
  if (excludeReservationId !== undefined && excludeReservationId !== null) {
    reservationWhere.id = { [Op.ne]: excludeReservationId };
  }

  const existingReservations = await Reservation.findAll({
    where: reservationWhere,
    attributes: ['id', 'equipmentId', 'time'],
  });

  const occupiedEquipmentIds = new Set();
  for (const existing of existingReservations) {
    const existingStart = parseTimeToMinutes(existing.time);
    if (existingStart === null) {
      occupiedEquipmentIds.add(existing.equipmentId);
      continue;
    }

    const existingEnd = existingStart + FIXED_DURATION_MINUTES;
    if (intervalsOverlap(existingStart, existingEnd, candidateStart, candidateEnd)) {
      occupiedEquipmentIds.add(existing.equipmentId);
    }
  }

  for (const eq of prioritized) {
    if (!occupiedEquipmentIds.has(eq.id)) {
      return eq;
    }
  }

  return null;
}

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
  const overlap = await hasEquipmentOverlap(equipmentId, date, time);
  return !overlap;
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
    if (!hasAllowedStartMinute(time)) {
      return res.status(400).json({ error: 'Invalid time. Allowed start minutes are 00, 15, 30, 45' });
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
      const hasDuplicateDate = await hasMemberDateReservation(memberId, date);
      if (hasDuplicateDate) {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
      }

      // Check slot availability (prevent double booking)
      const available = await isSlotAvailable(equipmentId, date, time);
      if (!available) return res.status(400).json({ error: 'Slot not available' });
      // Prevent member interval overlap on same date
      const memberOverlap = await hasMemberOverlap(memberId, date, time);
      if (memberOverlap) return res.status(400).json({ error: 'Member already has a reservation at this time' });
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
      const hasDuplicateDate = await hasMemberDateReservation(memberId, dStr);
      if (hasDuplicateDate) {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte zaten rezervasyonu var' });
      }
      const slotAvailable = await isSlotAvailable(equipmentId, dStr, time);
      if (!slotAvailable) {
        return res.status(400).json({ error: `Slot not available for ${dStr} ${time}` });
      }
      const memberOverlap = await hasMemberOverlap(memberId, dStr, time);
      if (memberOverlap) {
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
  const { startDate, endDate } = req.query;
  const isValidDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

  if ((startDate && !isValidDate(startDate)) || (endDate && !isValidDate(endDate))) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
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

  if (startDate && endDate) {
    where.date = { [Op.between]: [startDate, endDate] };
  } else if (startDate) {
    where.date = { [Op.gte]: startDate };
  } else if (endDate) {
    where.date = { [Op.lte]: endDate };
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

    const reservationsToDelete = await Reservation.findAll({
      where: {
        recurrenceGroupId: reservation.recurrenceGroupId,
        date: { [Op.gte]: dateStr }
      },
      attributes: ['id']
    });
    const reservationIdsToDelete = reservationsToDelete.map((row) => row.id);
    if (reservationIdsToDelete.length > 0) {
      const linkedAttendance = await Attendance.findOne({
        where: {
          reservationId: { [Op.in]: reservationIdsToDelete }
        }
      });
      if (linkedAttendance) {
        return res.status(409).json({ error: 'Silinecek rezervasyonlardan biri veya daha fazlası için yoklama alınmıştır. Önce ilgili yoklamaları siliniz.' });
      }
    }

    await Reservation.destroy({
      where: {
        recurrenceGroupId: reservation.recurrenceGroupId,
        date: { [Op.gte]: dateStr }
      }
    });
    return res.sendStatus(204);
  }

  const linkedAttendance = await Attendance.findOne({ where: { reservationId: reservation.id } });
  if (linkedAttendance) {
    return res.status(409).json({ error: 'Bu rezervasyon için yoklama alınmıştır. Önce yoklamayı siliniz.' });
  }

  // Default: delete only this reservation
  await reservation.destroy();
  res.sendStatus(204);
};
