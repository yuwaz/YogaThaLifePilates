// Delete assigned lesson package from member
exports.deleteAssignedLessonPackage = async (req, res) => {
  const { memberId, assignedPackageId } = req.params;
  const assignment = await MemberLessonPackage.findByPk(assignedPackageId, {
    include: [{ model: LessonPackage, attributes: ['lessonCount', 'price'] }]
  });
  if (!assignment || assignment.memberId != memberId) return res.sendStatus(404);
  const member = await Member.findByPk(memberId);
  if (!member) return res.sendStatus(404);
  // Debug logs before update
  const beforeLessons = member.remainingLessons;
  const beforeDebt = member.totalDebt;
  const lessonCount = assignment.LessonPackage ? assignment.LessonPackage.lessonCount : null;
  const price = assignment.LessonPackage ? assignment.LessonPackage.price : null;
  console.log('[deleteAssignedLessonPackage] memberId:', memberId);
  console.log('[deleteAssignedLessonPackage] assignmentId:', assignedPackageId);
  console.log('[deleteAssignedLessonPackage] member.remainingLessons before:', beforeLessons);
  console.log('[deleteAssignedLessonPackage] member.totalDebt before:', beforeDebt);
  console.log('[deleteAssignedLessonPackage] assigned package lessonCount:', lessonCount);
  console.log('[deleteAssignedLessonPackage] assigned package price:', price);
  if (lessonCount == null) console.log('[deleteAssignedLessonPackage] WARNING: lessonCount is null/undefined');
  if (price == null) console.log('[deleteAssignedLessonPackage] WARNING: price is null/undefined');
  // Reverse effect
  if (assignment.LessonPackage) {
    member.remainingLessons = Math.max(0, Number(member.remainingLessons) - Number(lessonCount));
    member.totalDebt = Math.max(0, Number(member.totalDebt) - Number(price));
    await member.save();
    // Debug logs after update
    console.log('[deleteAssignedLessonPackage] member.remainingLessons after:', member.remainingLessons);
    console.log('[deleteAssignedLessonPackage] member.totalDebt after:', member.totalDebt);
  }
  await assignment.destroy();
  res.sendStatus(204);
};
// Restore/reactivate member (admin only)
exports.restoreMember = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can reactivate members' });
    }
    const memberId = req.params.id;
    const member = await Member.findByPk(memberId);
    if (!member) {
      return res.status(404).json({ message: 'Member not found' });
    }
    member.isActive = true;
    member.deletedAt = null;
    await member.save();
    return res.json({ message: 'Member reactivated successfully', memberId });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to reactivate member', error: err.message });
  }
};
const { Member, MemberType, Salon, LessonPackage, Payment, Attendance, Reservation } = require('../models');
const { Op } = require('sequelize');

exports.createMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds, assignedInstructorId } = req.body;
    if (!name || !phone || !email || !memberTypeId || !assignedSalonIds) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof name !== 'string' || typeof phone !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (!/^\+90[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    if (!Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
    // Minimal validation: allow null or integer for assignedInstructorId
    let instructorId = assignedInstructorId;
    if (instructorId !== undefined && instructorId !== null && isNaN(Number(instructorId))) {
      return res.status(400).json({ error: 'assignedInstructorId must be an integer or null' });
    }
    const member = await Member.create({ name, phone, email, memberTypeId, assignedSalonIds, assignedInstructorId: instructorId });
    res.status(201).json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getMembers = async (req, res) => {
  try {
    console.log('[DEBUG] Entering getMembers endpoint');
    console.log('[DEBUG] req.user:', req.user);
    console.log('[DEBUG] req.query:', req.query);
    const onlyMyMembers = req.query.onlyMyMembers === 'true';
    let where = { isActive: true };
    let filterMode = 'all';
    if (req.user.role === 'instructor' && onlyMyMembers) {
      where.assignedInstructorId = req.user.id;
      filterMode = 'onlyMyMembers';
    }
    console.log('[DEBUG] final member filter mode:', filterMode);
    console.log('[DEBUG] before DB query, where:', where);
    const members = await Member.findAll({ where });
    console.log('[DEBUG] after DB query, count:', members.length);
    console.log('[DEBUG] before response.json');
    res.json(members);
  } catch (err) {
    console.error('[DEBUG] getMembers error:', err && err.message, err && err.stack);
    res.status(500).json({ error: 'Failed to fetch members', details: err && err.message });
  }
};

// GET /members/all (admin only)
exports.getAllMembers = async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  const members = await Member.findAll();
  res.json(members);
};

exports.getMember = async (req, res) => {
  const member = await Member.findByPk(req.params.id);
  if (!member) return res.sendStatus(404);
  // Get assigned lesson packages
  const assignments = await MemberLessonPackage.findAll({
    where: { memberId: member.id },
    include: [{
      model: LessonPackage,
      attributes: ['id', 'name', 'lessonCount', 'price']
    }],
    order: [['assignedAt', 'DESC']]
  });
  const assignedLessonPackages = assignments.map(a => ({
    id: a.id,
    lessonPackageId: a.lessonPackageId,
    name: a.LessonPackage?.name,
    lessonCount: a.LessonPackage?.lessonCount,
    price: a.LessonPackage?.price,
    assignedAt: a.assignedAt,
    originalPrice: a.originalPrice,
    discountType: a.discountType,
    discountValue: a.discountValue,
    finalPrice: a.finalPrice
  }));
  const memberObj = member.toJSON();
  memberObj.assignedLessonPackages = assignedLessonPackages;
  // Always include assignedInstructorId in detail
  res.json(memberObj);
};

exports.updateMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds, assignedInstructorId } = req.body;
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
    // Minimal validation: allow null or integer for assignedInstructorId
    if (assignedInstructorId !== undefined) {
      if (assignedInstructorId !== null && isNaN(Number(assignedInstructorId))) {
        return res.status(400).json({ error: 'assignedInstructorId must be an integer or null' });
      }
      member.assignedInstructorId = assignedInstructorId;
    }
    await member.save();
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteMember = async (req, res) => {
  const { sequelize } = require('../models');
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can deactivate members' });
    }
    const memberId = req.params.id;
    const member = await Member.findByPk(memberId);
    if (!member) {
      return res.status(404).json({ message: 'Member not found' });
    }
    // Business rule 1: Block if member has debt
    if (Number(member.totalDebt) > 0) {
      return res.status(400).json({ message: 'Borcu olan üye pasifleştirilemez. Lütfen önce borcu kapatın.' });
    }
    // Business rule 2: If member has remaining lessons, require confirmation
    const confirmResetLessons = req.body?.confirmResetLessons === true || req.query?.confirmResetLessons === 'true';
    if (Number(member.remainingLessons) > 0 && !confirmResetLessons) {
      return res.status(409).json({ message: 'Üyenin kalan dersi var. Pasifleştirilirse kalan dersler sıfırlanacak.' });
    }
    await sequelize.transaction(async (t) => {
      // If confirmed, zero out remaining lessons
      if (Number(member.remainingLessons) > 0) {
        member.remainingLessons = 0;
      }
      // Soft delete: set isActive=false, deletedAt=now
      member.isActive = false;
      member.deletedAt = new Date();
      await member.save({ transaction: t });
      // Delete all reservations for this member (single and recurring)
      await Reservation.destroy({
        where: { memberId },
        transaction: t
      });
      // Do NOT delete attendance or payments
    });
    return res.json({ message: 'Member deactivated successfully', memberId });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to deactivate member', error: err.message });
  }
};

// Add lesson package to member
const { MemberLessonPackage } = require('../models');
exports.addLessonPackage = async (req, res) => {
  try {
    const { lessonPackageId, discountType, discountValue } = req.body;
    const member = await Member.findByPk(req.params.id);
    if (!member) return res.sendStatus(404);
    const lessonPackage = await LessonPackage.findByPk(lessonPackageId);
    if (!lessonPackage) return res.status(400).json({ error: 'Lesson package not found' });

    // Discount logic
    const originalPrice = Number(lessonPackage.price);
    let finalPrice = originalPrice;
    let safeDiscountType = null;
    let safeDiscountValue = null;
    if (discountType === 'amount' || discountType === 'percent') {
      safeDiscountType = discountType;
      safeDiscountValue = Number(discountValue) || 0;
      if (discountType === 'amount') {
        if (safeDiscountValue < 0 || safeDiscountValue > originalPrice) {
          return res.status(400).json({ error: 'Invalid discount amount' });
        }
        finalPrice = originalPrice - safeDiscountValue;
      } else if (discountType === 'percent') {
        if (safeDiscountValue < 0 || safeDiscountValue > 100) {
          return res.status(400).json({ error: 'Invalid discount percent' });
        }
        finalPrice = originalPrice * (1 - safeDiscountValue / 100);
      }
      if (finalPrice < 0) finalPrice = 0;
    }

    // Debt logic: use finalPrice
    const newDebt = Number(member.totalDebt) + finalPrice;
    if (newDebt < 0) return res.status(400).json({ error: 'totalDebt cannot be negative' });
    member.totalDebt = newDebt;
    member.remainingLessons = Number(member.remainingLessons) + Number(lessonPackage.lessonCount);
    await member.save();
    // Insert assignment record with pricing fields
    const assignment = await MemberLessonPackage.create({
      memberId: member.id,
      lessonPackageId: lessonPackage.id,
      assignedAt: new Date(),
      originalPrice,
      discountType: safeDiscountType,
      discountValue: safeDiscountValue,
      finalPrice
    });
    // Return assignment info (including pricing fields)
    res.json({
      memberId: member.id,
      lessonPackageId: lessonPackage.id,
      assignedAt: assignment.assignedAt,
      originalPrice,
      discountType: safeDiscountType,
      discountValue: safeDiscountValue,
      finalPrice,
      memberTotalDebt: member.totalDebt,
      memberRemainingLessons: member.remainingLessons
    });
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
