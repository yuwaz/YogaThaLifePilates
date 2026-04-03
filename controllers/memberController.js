const { Member, MemberType, Salon, LessonPackage, Payment, Attendance } = require('../models');

exports.createMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds } = req.body;
    if (!/^\+90[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    const member = await Member.create({ name, phone, email, memberTypeId, assignedSalonIds });
    res.status(201).json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getMembers = async (req, res) => {
  const members = await Member.findAll();
  res.json(members);
};

exports.getMember = async (req, res) => {
  const member = await Member.findByPk(req.params.id);
  if (!member) return res.sendStatus(404);
  res.json(member);
};

exports.updateMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    if (phone && !/^\+90[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    if (name) member.name = name;
    if (phone) member.phone = phone;
    if (email) member.email = email;
    if (memberTypeId) member.memberTypeId = memberTypeId;
    if (assignedSalonIds) member.assignedSalonIds = assignedSalonIds;
    await member.save();
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteMember = async (req, res) => {
  const member = await Member.findByPk(req.params.id);
  if (!member) return res.sendStatus(404);
  await member.destroy();
  res.sendStatus(204);
};

// Add lesson package to member
exports.addLessonPackage = async (req, res) => {
  try {
    const { lessonPackageId } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const lessonPackage = await LessonPackage.findByPk(lessonPackageId);
    if (!lessonPackage) return res.status(400).json({ error: 'Lesson package not found' });
    member.totalDebt = Number(member.totalDebt) + Number(lessonPackage.price);
    member.remainingLessons = Number(member.remainingLessons) + Number(lessonPackage.lessonCount);
    await member.save();
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Track payment
exports.addPayment = async (req, res) => {
  try {
    const { amount, paymentMethodId, date } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const payment = await Payment.create({ memberId: member.id, amount, paymentMethodId, date });
    member.totalDebt = Number(member.totalDebt) - Number(amount);
    await member.save();
    res.status(201).json(payment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Track attendance
exports.addAttendance = async (req, res) => {
  try {
    const { salonId, date } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const attendance = await Attendance.create({ memberId: member.id, salonId, date });
    if (member.remainingLessons > 0) {
      member.remainingLessons = Number(member.remainingLessons) - 1;
      await member.save();
    }
    res.status(201).json(attendance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
