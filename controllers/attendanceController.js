const { Attendance, Member } = require('../models');

exports.getAttendance = async (req, res) => {
  try {
    const attendanceList = await Attendance.findAll({
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

    const member = await Member.findByPk(memberId);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

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

    res.status(201).json(attendance);
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
      member.remainingLessons = Number(member.remainingLessons) + 1;
      await member.save();
    }

    await attendance.destroy();
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
