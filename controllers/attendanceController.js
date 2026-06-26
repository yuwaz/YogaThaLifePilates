const { Attendance, Member, MemberType, Reservation } = require('../models');

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

async function findReservationMatch(memberId, attendanceDate) {
  const localDate = toLocalDateString(attendanceDate);
  if (!localDate) {
    return { kind: 'invalid-date' };
  }

  const reservations = await Reservation.findAll({
    where: {
      memberId,
      date: localDate,
    },
    attributes: ['id'],
    limit: 2,
    order: [['id', 'ASC']],
  });

  if (reservations.length === 0) return { kind: 'none' };
  if (reservations.length > 1) return { kind: 'multiple' };

  return { kind: 'single', reservationId: reservations[0].id };
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
      where,
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
    const instructorId = req.user && req.user.id ? Number(req.user.id) : null;

    if (!memberId || !salonId || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const member = await Member.findOne({ where: { id: memberId, isActive: true } });
    if (!member) {
      return res.status(404).json({ error: 'Member not found or inactive' });
    }

    const reservationMatch = await findReservationMatch(memberId, date);
    if (reservationMatch.kind === 'invalid-date') {
      return res.status(400).json({ error: 'Invalid attendance date' });
    }
    if (reservationMatch.kind === 'none') {
      return res.status(400).json({ error: 'Bu üyenin seçilen tarihte rezervasyonu bulunamadı' });
    }
    if (reservationMatch.kind === 'multiple') {
      return res.status(409).json({ error: 'Bu üyenin seçilen tarihte birden fazla rezervasyonu var' });
    }

    // Load MemberType for card-based logic
    const memberType = await MemberType.findByPk(member.memberTypeId);
    if (!memberType) {
      return res.status(400).json({ error: 'Member type not found' });
    }

    if (memberType.isCardBased) {
      // Card-based: allow attendance, do not check or decrement remainingLessons
      const attendance = await Attendance.create({
        memberId,
        salonId,
        date,
        reservationId: reservationMatch.reservationId,
        instructorId,
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
        date,
        reservationId: reservationMatch.reservationId,
        instructorId,
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
    const attendance = await Attendance.findByPk(req.params.id);
    if (!attendance) {
      return res.sendStatus(404);
    }

    const { date, salonId, memberId } = req.body;

    if (!salonId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const nextMemberId = memberId !== undefined ? Number(memberId) : attendance.memberId;
    if (Number.isNaN(nextMemberId)) {
      return res.status(400).json({ error: 'Invalid memberId' });
    }

    const nextDate = date !== undefined ? date : attendance.date;
    const currentLocalDate = toLocalDateString(attendance.date);
    const nextLocalDate = toLocalDateString(nextDate);
    if (!nextLocalDate) {
      return res.status(400).json({ error: 'Invalid attendance date' });
    }

    const memberChanged = nextMemberId !== attendance.memberId;
    if (memberChanged) {
      const member = await Member.findOne({ where: { id: nextMemberId, isActive: true } });
      if (!member) {
        return res.status(404).json({ error: 'Member not found or inactive' });
      }
    }

    const dateChanged = currentLocalDate !== nextLocalDate;
    if (memberChanged || dateChanged) {
      const reservationMatch = await findReservationMatch(nextMemberId, nextDate);
      if (reservationMatch.kind === 'none') {
        return res.status(400).json({ error: 'Bu üyenin seçilen tarihte rezervasyonu bulunamadı' });
      }
      if (reservationMatch.kind === 'multiple') {
        return res.status(409).json({ error: 'Bu üyenin seçilen tarihte birden fazla rezervasyonu var' });
      }
      if (reservationMatch.kind === 'invalid-date') {
        return res.status(400).json({ error: 'Invalid attendance date' });
      }
      attendance.reservationId = reservationMatch.reservationId;
    }

    attendance.memberId = nextMemberId;
    attendance.date = nextDate;
    attendance.salonId = salonId;
    await attendance.save();

    res.json(attendance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteAttendance = async (req, res) => {
  try {
    const attendance = await Attendance.findByPk(req.params.id);
    if (!attendance) {
      return res.sendStatus(404);
    }

    const member = await Member.findByPk(attendance.memberId);
    if (member) {
      // Load MemberType for card-based logic
      const memberType = await MemberType.findByPk(member.memberTypeId);
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
