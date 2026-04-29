const { Attendance, Member, MemberType } = require('../models');

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

    if (!memberId || !salonId || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const member = await Member.findOne({ where: { id: memberId, isActive: true } });
    if (!member) {
      return res.status(404).json({ error: 'Member not found or inactive' });
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

    const { date, salonId } = req.body;

    if (!date || !salonId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    attendance.date = date;
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
