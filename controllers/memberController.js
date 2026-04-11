const { Member, MemberType, Salon, LessonPackage, Payment, Attendance } = require('../models');

exports.createMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds } = req.body;
    if (!name || !phone || !email || !memberTypeId || !assignedSalonIds) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof name !== 'string' || typeof phone !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (!/^\+90[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    if (!Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
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
    if (name && typeof name !== 'string') return res.status(400).json({ error: 'Invalid name type' });
    if (phone && typeof phone !== 'string') return res.status(400).json({ error: 'Invalid phone type' });
    if (email && typeof email !== 'string') return res.status(400).json({ error: 'Invalid email type' });
    if (assignedSalonIds && !Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
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
  try {
    const memberId = req.params.id;
    console.log(`[DELETE MEMBER] Attempting to delete member id: ${memberId}`);
    const member = await Member.findByPk(memberId);
    if (!member) {
      console.log(`[DELETE MEMBER] Member not found: ${memberId}`);
      return res.status(404).json({ message: 'Member not found' });
    }
    // Delete related payments
    const deletedPayments = await Payment.destroy({ where: { memberId } });
    console.log(`[DELETE MEMBER] Deleted ${deletedPayments} related payments for member id: ${memberId}`);
    await member.destroy();
    console.log(`[DELETE MEMBER] Member deleted: ${memberId}`);
    return res.json({ message: 'Member and related payments deleted', memberId, deletedPayments });
  } catch (err) {
    console.error(`[DELETE MEMBER] Error deleting member:`, err);
    return res.status(500).json({ message: 'Failed to delete member', error: err.message });
  }
};

// Add lesson package to member
exports.addLessonPackage = async (req, res) => {
  try {
    const { lessonPackageId } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const lessonPackage = await LessonPackage.findByPk(lessonPackageId);
    if (!lessonPackage) return res.status(400).json({ error: 'Lesson package not found' });
    const newDebt = Number(member.totalDebt) + Number(lessonPackage.price);
    if (newDebt < 0) return res.status(400).json({ error: 'totalDebt cannot be negative' });
    member.totalDebt = newDebt;
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
    if (!amount || !paymentMethodId || !date) return res.status(400).json({ error: 'Missing required fields' });
    if (isNaN(amount) || Number(amount) < 0) return res.status(400).json({ error: 'Amount must be a non-negative number' });
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const newDebt = Number(member.totalDebt) - Number(amount);
    if (newDebt < 0) return res.status(400).json({ error: 'totalDebt cannot be negative' });
    const payment = await Payment.create({ memberId: member.id, amount, paymentMethodId, date });
    member.totalDebt = newDebt;
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
    if (!salonId || !date) return res.status(400).json({ error: 'Missing required fields' });
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    if (member.remainingLessons <= 0) return res.status(400).json({ error: 'No remaining lessons' });
    const attendance = await Attendance.create({ memberId: member.id, salonId, date });
    member.remainingLessons = Number(member.remainingLessons) - 1;
    await member.save();
    res.status(201).json(attendance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
