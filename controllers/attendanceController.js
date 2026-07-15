const { Attendance, Member, MemberType, Reservation, Salon } = require('../models');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

const LOCAL_TIMEZONE = 'Europe/Istanbul';

function toLocalDateString(value) {
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsedDate);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function combineDateAndTime(dateOnly, reservationTime) {
  if (!dateOnly || !reservationTime) return null;

  const trimmedTime = String(reservationTime).trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(trimmedTime)) return null;

  const normalizedTime = trimmedTime.length === 5 ? `${trimmedTime}:00` : trimmedTime;
  return `${dateOnly} ${normalizedTime}`;
}

async function findReservationMatch(memberId, attendanceDate, options = {}) {
  const { studioId, salonId } = options;
  const localDate = toLocalDateString(attendanceDate);
  if (!localDate) {
    return { kind: 'invalid-date' };
  }

  const reservations = await Reservation.findAll({
    where: {
      memberId,
      date: localDate,
      studioId,
      ...(salonId !== undefined ? { salonId } : {}),
    },
    attributes: ['id', 'date', 'time'],
    limit: 2,
    order: [['id', 'ASC']],
  });

  if (reservations.length === 0) return { kind: 'none' };
  if (reservations.length > 1) return { kind: 'multiple' };

  return {
    kind: 'single',
    reservationId: reservations[0].id,
    reservationDate: reservations[0].date,
    reservationTime: reservations[0].time,
    localDate,
  };
}

exports.getAttendance = async (req, res) => {
  try {
    let where = {};
    if (req.query.assignedSalonIds) {
      // Only for instructors: restrict to assigned salons
      console.log('[DEBUG] Filtering attendances for assignedSalonIds:', req.query.assignedSalonIds);
      where.salonId = req.query.assignedSalonIds;
    }
    const attendanceList = await Attendance.findAll({
      where: withStudioWhere(req, where),
      order: [['date', 'DESC']],
    });
    res.json(attendanceList);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.addAttendance = async (req, res) => {
  try {
    const { memberId, salonId, date } = req.body;
    const studioId = getAuthenticatedStudioId(req);
    const instructorId = req.user && req.user.id ? Number(req.user.id) : null;

    if (!memberId || !salonId || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const salon = await Salon.findOne({ where: withStudioWhere(req, { id: salonId }) });
    if (!salon) return res.sendStatus(404);

    const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId, isActive: true }) });
    if (!member) {
      return res.sendStatus(404);
    }

    const reservationMatch = await findReservationMatch(memberId, date, { studioId, salonId: Number(salonId) });
    if (reservationMatch.kind === 'invalid-date') {
      return res.status(400).json({ error: 'Invalid attendance date' });
    }
    if (reservationMatch.kind === 'none') {
      return res.status(400).json({ error: 'Bu üyenin seçilen tarihte rezervasyonu bulunamadı' });
    }
    if (reservationMatch.kind === 'multiple') {
      return res.status(409).json({ error: 'Bu üyenin seçilen tarihte birden fazla rezervasyonu var' });
    }

    const attendanceDateTime = combineDateAndTime(
      reservationMatch.localDate || reservationMatch.reservationDate,
      reservationMatch.reservationTime,
    );
    if (!attendanceDateTime) {
      return res.status(400).json({ error: 'Invalid reservation time' });
    }

    // Load MemberType for card-based logic
    const memberType = await MemberType.findOne({ where: withStudioWhere(req, { id: member.memberTypeId }) });
    if (!memberType) {
      return res.status(400).json({ error: 'Member type not found' });
    }

    if (memberType.isCardBased) {
      // Card-based: allow attendance, do not check or decrement remainingLessons
      const attendance = await Attendance.create({
        memberId,
        salonId,
        date: attendanceDateTime,
        reservationId: reservationMatch.reservationId,
        instructorId,
        studioId,
      });
      return res.status(201).json(attendance);
    } else {
      // Normal: require remainingLessons > 0, decrement as before
      if (Number(member.remainingLessons) <= 0) {
        return res.status(400).json({ error: 'No remaining lessons' });
      }
      const attendance = await Attendance.create({
        memberId,
        salonId,
        date: attendanceDateTime,
        reservationId: reservationMatch.reservationId,
        instructorId,
        studioId,
      });
      member.remainingLessons = Number(member.remainingLessons) - 1;
      await member.save();
      return res.status(201).json(attendance);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.updateAttendance = async (req, res) => {
  try {
    const studioId = getAuthenticatedStudioId(req);
    const attendance = await Attendance.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!attendance) {
      return res.sendStatus(404);
    }

    const { date, salonId, memberId } = req.body;

    if (!salonId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const salon = await Salon.findOne({ where: withStudioWhere(req, { id: salonId }) });
    if (!salon) {
      return res.sendStatus(404);
    }

    const nextMemberId = memberId !== undefined ? Number(memberId) : attendance.memberId;
    if (Number.isNaN(nextMemberId)) {
      return res.status(400).json({ error: 'Invalid memberId' });
    }

    const nextDate = date !== undefined ? date : attendance.date;
    const nextSalonId = Number(salonId);
    const currentLocalDate = toLocalDateString(attendance.date);
    const nextLocalDate = toLocalDateString(nextDate);
    if (!nextLocalDate) {
      return res.status(400).json({ error: 'Invalid attendance date' });
    }

    const memberChanged = nextMemberId !== attendance.memberId;
    if (memberChanged) {
      const member = await Member.findOne({ where: withStudioWhere(req, { id: nextMemberId, isActive: true }) });
      if (!member) {
        return res.sendStatus(404);
      }
    }

    const dateChanged = currentLocalDate !== nextLocalDate;
    const salonChanged = nextSalonId !== Number(attendance.salonId);
    let nextAttendanceDate = attendance.date;
    if (memberChanged || dateChanged || salonChanged) {
      const reservationMatch = await findReservationMatch(nextMemberId, nextDate, { studioId, salonId: nextSalonId });
      if (reservationMatch.kind === 'none') {
        return res.status(400).json({ error: 'Bu üyenin seçilen tarihte rezervasyonu bulunamadı' });
      }
      if (reservationMatch.kind === 'multiple') {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte birden fazla rezervasyonu var' });
      }
      if (reservationMatch.kind === 'invalid-date') {
        return res.status(400).json({ error: 'Invalid attendance date' });
      }

      nextAttendanceDate = combineDateAndTime(
        reservationMatch.localDate || reservationMatch.reservationDate,
        reservationMatch.reservationTime,
      );
      if (!nextAttendanceDate) {
        return res.status(400).json({ error: 'Invalid reservation time' });
      }

      attendance.reservationId = reservationMatch.reservationId;
    }

    attendance.memberId = nextMemberId;
    attendance.date = nextAttendanceDate;
  attendance.salonId = salonId;
    await attendance.save();

    res.json(attendance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteAttendance = async (req, res) => {
  try {
    const attendance = await Attendance.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!attendance) {
      return res.sendStatus(404);
    }

    const member = await Member.findOne({ where: withStudioWhere(req, { id: attendance.memberId }) });
    if (member) {
      // Load MemberType for card-based logic
      const memberType = await MemberType.findOne({ where: withStudioWhere(req, { id: member.memberTypeId }) });
      if (memberType && memberType.isCardBased) {
        // Card-based: just delete attendance, do not increment remainingLessons
        await attendance.destroy();
        return res.sendStatus(204);
      } else {
        // Normal: increment remainingLessons as before
        member.remainingLessons = Number(member.remainingLessons) + 1;
        await member.save();
        await attendance.destroy();
        return res.sendStatus(204);
      }
    }
    // If no member found, just delete attendance
    await attendance.destroy();
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
