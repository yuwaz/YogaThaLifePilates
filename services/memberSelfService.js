const { Op } = require('sequelize');
const {
  Member,
  MemberType,
  Studio,
  MemberMeasurement,
  MemberLessonPackage,
  LessonPackage,
  Reservation,
  Salon,
  Equipment,
  Attendance,
  User,
  Payment,
  PaymentMethod,
} = require('../models');

const MAX_LIMIT = 100;

function getContext(req) {
  const memberId = Number(req.memberId);
  const studioId = Number(req.memberStudioId);
  if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isInteger(studioId) || studioId <= 0) {
    throw new Error('Invalid member context');
  }
  return { memberId, studioId };
}

function validateLimit(value) {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new Error('Invalid limit');
  }
  return limit;
}

function validateDate(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function measurementPayload(measurement) {
  if (!measurement) return null;
  return {
    id: measurement.id,
    measuredAt: measurement.measuredAt,
    height: measurement.height,
    weight: measurement.weight,
    waist: measurement.waist,
    hip: measurement.hip,
    chest: measurement.chest,
    arm: measurement.arm,
    leg: measurement.leg,
    shoulder: measurement.shoulder,
    bodyFatPercentage: measurement.bodyFatPercentage,
  };
}

function reservationPayload(reservation) {
  return {
    id: reservation.id,
    date: reservation.date,
    time: reservation.time,
    salon: reservation.Salon ? { id: reservation.Salon.id, name: reservation.Salon.name } : null,
    equipment: reservation.Equipment ? { id: reservation.Equipment.id, name: reservation.Equipment.name } : null,
    recurrence: {
      groupId: reservation.recurrenceGroupId,
      type: reservation.recurrenceType,
      endDate: reservation.recurrenceEndDate,
    },
  };
}

function packagePayload(assignment) {
  return {
    assignmentId: assignment.id,
    packageId: assignment.lessonPackageId,
    name: assignment.LessonPackage?.name || null,
    lessonCount: assignment.LessonPackage?.lessonCount || null,
    price: assignment.LessonPackage?.price || null,
    assignedAt: assignment.assignedAt,
    originalPrice: assignment.originalPrice,
    discountType: assignment.discountType,
    discountValue: assignment.discountValue,
    finalPrice: assignment.finalPrice,
  };
}

function attendancePayload(attendance) {
  return {
    id: attendance.id,
    date: attendance.date,
    reservationId: attendance.reservationId,
    salon: attendance.Salon ? { id: attendance.Salon.id, name: attendance.Salon.name } : null,
    instructor: attendance.Instructor ? { id: attendance.Instructor.id, name: attendance.Instructor.username } : null,
  };
}

function paymentPayload(payment) {
  return {
    id: payment.id,
    amount: payment.amount,
    date: payment.date,
    paymentMethod: payment.PaymentMethod ? { name: payment.PaymentMethod.name } : null,
  };
}

async function getMember(req) {
  const { memberId, studioId } = getContext(req);
  const member = await Member.findOne({
    where: { id: memberId, studioId, isActive: true, deletedAt: null },
    attributes: ['id', 'name', 'phone', 'email', 'memberTypeId', 'createdAt', 'remainingLessons', 'totalDebt', 'assignedInstructorId'],
    include: [
      { model: MemberType, attributes: ['id', 'name'], required: false },
      { model: Studio, attributes: ['id', 'name'], required: true },
    ],
  });
  if (!member) throw new Error('Member access unavailable');
  const latestMeasurement = await MemberMeasurement.findOne({
    where: { memberId, studioId },
    order: [['measuredAt', 'DESC'], ['id', 'DESC']],
  });
  let assignedInstructor = null;
  if (member.assignedInstructorId) {
    // re-enforce same-studio at read time; ignore any stale/cross-studio value
    const instructor = await User.findOne({
      where: { id: member.assignedInstructorId, studioId },
      attributes: ['id', 'username'],
    });
    if (instructor) {
      assignedInstructor = { id: instructor.id, name: instructor.username };
    }
  }
  return {
    member: {
      id: member.id,
      name: member.name,
      phone: member.phone,
      email: member.email,
      memberType: member.MemberType ? { id: member.MemberType.id, name: member.MemberType.name } : null,
      createdAt: member.createdAt,
    },
    studio: { id: member.Studio.id, name: member.Studio.name },
    summary: {
      remainingLessons: member.remainingLessons,
      totalDebt: member.totalDebt,
      latestMeasurement: measurementPayload(latestMeasurement),
    },
    assignedInstructor,
  };
}

async function getMeasurements(req) {
  const { memberId, studioId } = getContext(req);
  const measurements = await MemberMeasurement.findAll({
    where: { memberId, studioId },
    attributes: ['id', 'measuredAt', 'height', 'weight', 'waist', 'hip', 'chest', 'arm', 'leg', 'shoulder', 'bodyFatPercentage'],
    order: [['measuredAt', 'DESC'], ['id', 'DESC']],
  });
  return measurements.map(measurementPayload);
}

async function getReservations(req) {
  const { memberId, studioId } = getContext(req);
  const from = validateDate(req.query?.from, 'from date');
  const to = validateDate(req.query?.to, 'to date');
  const limit = validateLimit(req.query?.limit);
  if (from && to && from > to) throw new Error('Invalid date range');
  const where = { memberId, studioId };
  if (from && to) where.date = { [Op.between]: [from, to] };
  else if (from) where.date = { [Op.gte]: from };
  else if (to) where.date = { [Op.lte]: to };
  const reservations = await Reservation.findAll({
    where,
    include: [
      { model: Salon, attributes: ['id', 'name'], required: false },
      { model: Equipment, attributes: ['id', 'name'], required: false },
    ],
    order: [['date', 'ASC'], ['time', 'ASC'], ['id', 'ASC']],
    ...(limit ? { limit } : {}),
  });
  return reservations.map(reservationPayload);
}

async function getPackages(req) {
  const { memberId, studioId } = getContext(req);
  const member = await Member.findOne({
    where: { id: memberId, studioId, isActive: true, deletedAt: null },
    attributes: ['remainingLessons'],
  });
  if (!member) throw new Error('Member access unavailable');
  const packages = await MemberLessonPackage.findAll({
    where: { memberId, studioId },
    include: [{ model: LessonPackage, attributes: ['id', 'name', 'lessonCount', 'price'], required: false }],
    order: [['assignedAt', 'DESC'], ['id', 'DESC']],
  });
  return { remainingLessons: member.remainingLessons, packages: packages.map(packagePayload) };
}

async function getAttendances(req) {
  const { memberId, studioId } = getContext(req);
  const attendances = await Attendance.findAll({
    where: { memberId, studioId },
    attributes: ['id', 'date', 'reservationId', 'salonId', 'instructorId'],
    include: [
      { model: Salon, attributes: ['id', 'name'], required: false },
      { model: Reservation, attributes: ['id'], required: false },
      { model: User, as: 'Instructor', attributes: ['id', 'username'], required: false },
    ],
    order: [['date', 'DESC'], ['id', 'DESC']],
  });
  return attendances.map(attendancePayload);
}

async function getPayments(req) {
  const { memberId, studioId } = getContext(req);
  const member = await Member.findOne({
    where: { id: memberId, studioId, isActive: true, deletedAt: null },
    attributes: ['totalDebt'],
  });
  if (!member) throw new Error('Member access unavailable');
  const payments = await Payment.findAll({
    where: { memberId, studioId },
    attributes: ['id', 'amount', 'date', 'paymentMethodId'],
    include: [{ model: PaymentMethod, attributes: ['name'], required: false }],
    order: [['date', 'DESC'], ['id', 'DESC']],
  });
  return { totalDebt: member.totalDebt, payments: payments.map(paymentPayload) };
}

module.exports = {
  MAX_LIMIT,
  getContext,
  getMember,
  getMeasurements,
  getReservations,
  getPackages,
  getAttendances,
  getPayments,
};
