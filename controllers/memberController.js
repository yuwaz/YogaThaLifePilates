// Delete assigned lesson package from member
exports.deleteAssignedLessonPackage = async (req, res) => {
  const { memberId, assignedPackageId } = req.params;
  const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId }) });
  if (!member) return res.sendStatus(404);

  const assignment = await MemberLessonPackage.findOne({
    where: withStudioWhere(req, { id: assignedPackageId, memberId: member.id }),
    include: [{ model: LessonPackage, attributes: ['lessonCount', 'price'] }]
  });
  if (!assignment) return res.sendStatus(404);
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
    const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId }) });
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
const { sequelize, Member, MemberMeasurement, MemberType, Salon, LessonPackage, Payment, PaymentMethod, Attendance, Reservation, MemberLessonPackage, User } = require('../models');
const { Op } = require('sequelize');
const { withStudioWhere, getAuthenticatedStudioId } = require('../middleware/tenantContext');

const measurementFields = ['height', 'weight', 'waist', 'hip', 'chest', 'arm', 'leg', 'shoulder', 'bodyFatPercentage'];

function pickMeasurementFields(source) {
  return Object.fromEntries(measurementFields.map((field) => [field, source?.[field]]));
}

function normalizeNullableDecimalField(value) {
  if (value === undefined) {
    return { provided: false };
  }
  if (value === null) {
    return { provided: true, value: null };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return { provided: true, value: null };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { provided: true, error: 'Measurement fields must be numeric, null, or empty' };
    }
    return { provided: true, value: parsed };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { provided: true, error: 'Measurement fields must be numeric, null, or empty' };
    }
    return { provided: true, value };
  }
  return { provided: true, error: 'Measurement fields must be numeric, null, or empty' };
}

function normalizeMeasuredAtInput(value) {
  if (value === undefined || value === null || value === '') {
    return { value: new Date() };
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return { error: 'measuredAt must be a valid date' };
  }

  return { value: parsedDate };
}

async function validateMemberRelations(req, { memberTypeId, assignedSalonIds, assignedInstructorId }) {
  const normalized = {};

  if (memberTypeId !== undefined) {
    const parsedMemberTypeId = Number(memberTypeId);
    if (!Number.isInteger(parsedMemberTypeId) || parsedMemberTypeId <= 0) {
      throw { status: 400, message: 'memberTypeId must be an integer' };
    }
    const memberType = await MemberType.findOne({ where: withStudioWhere(req, { id: parsedMemberTypeId }) });
    if (!memberType) {
      throw { status: 404, message: 'Not found' };
    }
    normalized.memberTypeId = parsedMemberTypeId;
  }

  if (assignedSalonIds !== undefined) {
    if (!Array.isArray(assignedSalonIds)) {
      throw { status: 400, message: 'assignedSalonIds must be an array' };
    }

    const parsedSalonIds = assignedSalonIds.map((value) => Number(value));
    if (parsedSalonIds.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw { status: 404, message: 'Not found' };
    }

    const uniqueSalonIds = [...new Set(parsedSalonIds)];
    if (uniqueSalonIds.length > 0) {
      const salonCount = await Salon.count({
        where: withStudioWhere(req, {
          id: { [Op.in]: uniqueSalonIds },
        }),
      });
      if (salonCount !== uniqueSalonIds.length) {
        throw { status: 404, message: 'Not found' };
      }
    }

    normalized.assignedSalonIds = parsedSalonIds;
  }

  if (assignedInstructorId !== undefined) {
    if (assignedInstructorId === null) {
      normalized.assignedInstructorId = null;
    } else {
      const parsedInstructorId = Number(assignedInstructorId);
      if (!Number.isInteger(parsedInstructorId) || parsedInstructorId <= 0) {
        throw { status: 400, message: 'assignedInstructorId must be an integer or null' };
      }
      const instructor = await User.findOne({
        where: withStudioWhere(req, {
          id: parsedInstructorId,
          role: 'instructor',
        }),
      });
      if (!instructor) {
        throw { status: 404, message: 'Not found' };
      }
      normalized.assignedInstructorId = parsedInstructorId;
    }
  }

  return normalized;
}

async function emailExistsInStudio(req, email, excludeMemberId) {
  if (email === null || email === undefined) return false;

  const where = withStudioWhere(req, { email });
  if (excludeMemberId !== undefined && excludeMemberId !== null) {
    where.id = { [Op.ne]: Number(excludeMemberId) };
  }

  const existing = await Member.findOne({ where, attributes: ['id'] });
  return Boolean(existing);
}

exports.createMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds, assignedInstructorId } = req.body;
    if (!name || !phone || !memberTypeId || !assignedSalonIds) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof name !== 'string' || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    // Email is optional, but if present, must be string
    if (email !== undefined && email !== null && typeof email !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    // Normalize phone: remove spaces, dashes, parentheses
    let normalizedPhone = phone.replace(/[\s\-()]/g, '');
    // Keep +90 if present
    if (!/^\+90[0-9]{10}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    }
    if (!Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });
    // Prevent duplicate active members by name or phone (tenant-scoped)
    const duplicate = await Member.findOne({
      where: withStudioWhere(req, {
        isActive: true,
        [Op.or]: [
          { name },
          { phone: normalizedPhone }
        ]
      })
    });
    if (duplicate) {
      return res.status(400).json({ error: 'Aynı isim veya telefon numarasıyla kayıtlı bir üye zaten var.' });
    }
    const relationValidation = await validateMemberRelations(req, {
      memberTypeId,
      assignedSalonIds,
      assignedInstructorId,
    });

    // Email: allow null, trim if present, else null
    const safeEmail = typeof email === 'string' && email.trim() !== '' ? email.trim() : null;
    if (safeEmail !== null && await emailExistsInStudio(req, safeEmail)) {
      return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
    }
    const memberPayload = {
      name,
      phone: normalizedPhone,
      email: safeEmail,
      memberTypeId: relationValidation.memberTypeId,
      assignedSalonIds: relationValidation.assignedSalonIds,
      assignedInstructorId: relationValidation.assignedInstructorId,
      studioId: getAuthenticatedStudioId(req),
    };
    for (const field of measurementFields) {
      const normalized = normalizeNullableDecimalField(req.body[field]);
      if (normalized.error) {
        return res.status(400).json({ error: normalized.error });
      }
      if (normalized.provided) {
        memberPayload[field] = normalized.value;
      }
    }
    const member = await Member.create(memberPayload);
    res.status(201).json(member);
  } catch (error) {
    if (error && Number.isInteger(error.status)) {
      return res.status(error.status).json({ error: error.message || 'Not found' });
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      const field = error.errors?.[0]?.path;
      if (field === 'phone') {
        return res.status(400).json({ error: 'Bu telefon numarası zaten kayıtlı' });
      } else if (field === 'email') {
        return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
      }
    }
    console.error('createMember error name:', error.name);
    console.error('createMember errors:', error.errors?.map(e => ({
      message: e.message,
      path: e.path,
      value: e.value,
      validatorKey: e.validatorKey
    })));
    res.status(400).json({ error: error.message, details: error.errors?.map(e => ({
      message: e.message,
      path: e.path,
      value: e.value,
      validatorKey: e.validatorKey
    })) });
  }
};

exports.getMembers = async (req, res) => {
  try {
    console.log('[DEBUG] Entering getMembers endpoint');
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
    const members = await Member.findAll({ where: withStudioWhere(req, where) });
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
  const members = await Member.findAll({ where: withStudioWhere(req, {}) });
  res.json(members);
};

exports.getMember = async (req, res) => {
  const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
  if (!member) return res.sendStatus(404);
  // Get assigned lesson packages
  const assignments = await MemberLessonPackage.findAll({
    where: withStudioWhere(req, { memberId: member.id }),
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

exports.getMemberMeasurements = async (req, res) => {
  try {
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);

    const measurements = await MemberMeasurement.findAll({
      where: withStudioWhere(req, { memberId: member.id }),
      order: [['measuredAt', 'DESC'], ['id', 'DESC']],
    });

    return res.json(measurements);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.addMemberMeasurement = async (req, res) => {
  try {
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);

    const normalizedMeasuredAt = normalizeMeasuredAtInput(req.body.measuredAt);
    if (normalizedMeasuredAt.error) {
      return res.status(400).json({ error: normalizedMeasuredAt.error });
    }

    if (
      req.body.notes !== undefined &&
      req.body.notes !== null &&
      typeof req.body.notes !== 'string'
    ) {
      return res.status(400).json({ error: 'notes must be a string' });
    }

    const snapshotMeasurements = pickMeasurementFields(member.toJSON());
    for (const field of measurementFields) {
      const normalized = normalizeNullableDecimalField(req.body[field]);
      if (normalized.error) {
        return res.status(400).json({ error: normalized.error });
      }
      if (normalized.provided) {
        snapshotMeasurements[field] = normalized.value;
      }
    }

    const notes = typeof req.body.notes === 'string' && req.body.notes.trim() !== ''
      ? req.body.notes.trim()
      : null;
    const createdByUserId = req.user?.id ? Number(req.user.id) : null;

    let createdMeasurement;
    await sequelize.transaction(async (t) => {
      createdMeasurement = await MemberMeasurement.create({
        memberId: member.id,
        measuredAt: normalizedMeasuredAt.value,
        ...snapshotMeasurements,
        notes,
        createdByUserId,
        studioId: getAuthenticatedStudioId(req),
      }, { transaction: t });

      member.set(snapshotMeasurements);
      await member.save({ transaction: t });
    });

    return res.status(201).json(createdMeasurement);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.updateMember = async (req, res) => {
  try {
    const { name, phone, email, memberTypeId, assignedSalonIds, assignedInstructorId } = req.body;
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);
    if (phone && !/^\+90[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with +90 and have 12 digits' });
    if (name && typeof name !== 'string') return res.status(400).json({ error: 'Invalid name type' });
    if (phone && typeof phone !== 'string') return res.status(400).json({ error: 'Invalid phone type' });
    if (email !== undefined && email !== null && typeof email !== 'string') return res.status(400).json({ error: 'Invalid email type' });
    if (assignedSalonIds && !Array.isArray(assignedSalonIds)) return res.status(400).json({ error: 'assignedSalonIds must be an array' });

    const relationValidation = await validateMemberRelations(req, {
      memberTypeId,
      assignedSalonIds,
      assignedInstructorId,
    });

    if (name) member.name = name;
    if (phone) member.phone = phone;
    // Email: allow null, trim if present, else null
    if (email !== undefined) {
      const safeEmail = typeof email === 'string' && email.trim() !== '' ? email.trim() : null;
      if (safeEmail !== null && await emailExistsInStudio(req, safeEmail, member.id)) {
        return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
      }
      member.email = safeEmail;
    }
    if (memberTypeId) member.memberTypeId = relationValidation.memberTypeId;
    if (assignedSalonIds) member.assignedSalonIds = relationValidation.assignedSalonIds;
    if (assignedInstructorId !== undefined) member.assignedInstructorId = relationValidation.assignedInstructorId;
    const measurementUpdates = {};
    for (const field of measurementFields) {
      const normalized = normalizeNullableDecimalField(req.body[field]);
      if (normalized.error) {
        return res.status(400).json({ error: normalized.error });
      }
      if (normalized.provided) {
        measurementUpdates[field] = normalized.value;
      }
    }
    member.set(measurementUpdates);
    await member.save();
    const savedMember = await Member.findOne({ where: withStudioWhere(req, { id: member.id }) });
    if (!savedMember) return res.sendStatus(404);
    res.json(savedMember);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

exports.deleteMember = async (req, res) => {
  const { sequelize } = require('../models');
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can deactivate members' });
    }
    const memberId = req.params.id;
    const member = await Member.findOne({ where: withStudioWhere(req, { id: memberId }) });
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
        where: withStudioWhere(req, { memberId }),
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
exports.addLessonPackage = async (req, res) => {
  try {
    const { lessonPackageId, discountType, discountValue } = req.body;
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);
    const lessonPackage = await LessonPackage.findOne({ where: withStudioWhere(req, { id: lessonPackageId }) });
    if (!lessonPackage) return res.sendStatus(404);

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
      finalPrice,
      studioId: getAuthenticatedStudioId(req),
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
    const studioId = getAuthenticatedStudioId(req);
    if (!amount || !paymentMethodId || !date) return res.status(400).json({ error: 'Missing required fields' });
    if (isNaN(amount) || Number(amount) < 0) return res.status(400).json({ error: 'Amount must be a non-negative number' });
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);
    const paymentMethod = await PaymentMethod.findOne({ where: { id: paymentMethodId, studioId } });
    if (!paymentMethod) return res.sendStatus(404);
    const newDebt = Number(member.totalDebt) - Number(amount);
    if (newDebt < 0) return res.status(400).json({ error: 'totalDebt cannot be negative' });
    const payment = await Payment.create({ memberId: member.id, amount, paymentMethodId, date, studioId });
    member.totalDebt = newDebt;
    await member.save();
    res.status(201).json(payment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Track attendance
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

exports.addAttendance = async (req, res) => {
  try {
    const { salonId, date } = req.body;
    const studioId = getAuthenticatedStudioId(req);
    const instructorId = req.user && req.user.id ? Number(req.user.id) : null;
    if (!salonId || !date) return res.status(400).json({ error: 'Missing required fields' });
    const member = await Member.findOne({ where: withStudioWhere(req, { id: req.params.id }) });
    if (!member) return res.sendStatus(404);

    const reservationMatch = await findReservationMatch(member.id, date, { studioId, salonId: Number(salonId) });
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

    if (member.remainingLessons <= 0) return res.status(400).json({ error: 'No remaining lessons' });
    const attendance = await Attendance.create({
      memberId: member.id,
      salonId,
      date: attendanceDateTime,
      reservationId: reservationMatch.reservationId,
      instructorId,
      studioId,
    });
    member.remainingLessons = Number(member.remainingLessons) - 1;
    await member.save();
    res.status(201).json(attendance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
