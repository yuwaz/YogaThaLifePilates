const { Attendance, Member } = require('../models');

exports.deleteAttendance = async (req, res) => {
  try {
    const attendance = await Attendance.findByPk(req.params.id);
    if (!attendance) return res.sendStatus(404);
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
