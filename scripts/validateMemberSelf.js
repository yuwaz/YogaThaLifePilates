const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Fail-closed disposable DB guard: must run before requiring ../models or any DB-owning module ---
const repoDbPath = path.resolve(__dirname, '..', 'database.sqlite');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validateMemberSelf-'));
const disposableDbPath = path.join(tmpDir, 'validateMemberSelf.sqlite');

if (typeof disposableDbPath !== 'string' || disposableDbPath.trim() === '') {
  throw new Error('Refusing to run: disposable DB path is empty');
}
if (path.resolve(disposableDbPath) === repoDbPath) {
  throw new Error('Refusing to run: disposable DB path resolved to the repository database.sqlite');
}
const resolvedTmpDir = path.resolve(os.tmpdir());
if (!path.resolve(disposableDbPath).startsWith(resolvedTmpDir + path.sep)) {
  throw new Error('Refusing to run: disposable DB path is outside the intended temp directory');
}

process.env.DB_PATH = disposableDbPath;

const jwt = require('jsonwebtoken');
const models = require('../models');
const controller = require('../controllers/memberSelfController');
const { authenticateMemberContext } = require('../middleware/memberAuth');
const { signMemberContextToken } = require('../utils/memberAuthToken');

// Belt-and-braces: confirm Sequelize actually bound to the disposable DB, never the repo DB.
const boundStoragePath = path.resolve(models.sequelize.options.storage);
if (boundStoragePath !== path.resolve(disposableDbPath) || boundStoragePath === repoDbPath) {
  throw new Error('Refusing to run: Sequelize did not bind to the expected disposable DB path');
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function run(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

function contextRequest(accountId, membershipId, studioId, memberId, query = {}) {
  return {
    memberAccountId: accountId,
    memberStudioId: studioId,
    memberId,
    memberMembership: { id: membershipId, accountId, studioId, memberId },
    query,
  };
}

async function createFixtureMember(studio, name, phone) {
  const memberType = await models.MemberType.create({ name: `${name} type`, color: '#123456', studioId: studio.id });
  return models.Member.create({ name, phone, normalizedPhone: phone, email: `${name.toLowerCase()}@example.com`, memberTypeId: memberType.id, remainingLessons: 7, totalDebt: 1250.5, studioId: studio.id });
}

(async () => {
  process.env.MEMBER_JWT_SECRET = 'temporary-self-api-secret';
  await models.sequelize.sync({ force: true });

  const studioA = await models.Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await models.Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const memberA = await createFixtureMember(studioA, 'Alice', '+905321234567');
  const memberB = await createFixtureMember(studioB, 'Bob', '+905321234568');
  const account = await models.MemberAccount.create({ normalizedPhone: '+905321234567', passwordHash: 'hash', status: 'active' });
  const membershipA = await models.MemberAccountMembership.create({ accountId: account.id, studioId: studioA.id, memberId: memberA.id });
  const membershipB = await models.MemberAccountMembership.create({ accountId: account.id, studioId: studioB.id, memberId: memberB.id });
  const salonA = await models.Salon.create({ name: 'Salon A', type: 'studio', studioId: studioA.id });
  const equipmentA = await models.Equipment.create({ name: 'Mat A', type: 'mat', salonId: salonA.id, studioId: studioA.id });
  const salonB = await models.Salon.create({ name: 'Salon B', type: 'studio', studioId: studioB.id });
  const equipmentB = await models.Equipment.create({ name: 'Mat B', type: 'mat', salonId: salonB.id, studioId: studioB.id });
  const packageA = await models.LessonPackage.create({ name: 'Ten Lessons A', lessonCount: 10, price: 1000, studioId: studioA.id });
  const assignmentA = await models.MemberLessonPackage.create({ memberId: memberA.id, lessonPackageId: packageA.id, studioId: studioA.id, originalPrice: 1000, finalPrice: 900, discountType: 'percent', discountValue: 10 });
  const packageB = await models.LessonPackage.create({ name: 'Ten Lessons B', lessonCount: 10, price: 2000, studioId: studioB.id });
  await models.MemberLessonPackage.create({ memberId: memberB.id, lessonPackageId: packageB.id, studioId: studioB.id, originalPrice: 2000, finalPrice: 2000 });
  const reservationA = await models.Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-28', time: '18:00', studioId: studioA.id });
  await models.Reservation.create({ memberId: memberB.id, equipmentId: equipmentB.id, salonId: salonB.id, date: '2026-08-29', time: '19:00', studioId: studioB.id });
  const staff = await models.User.create({ username: 'instructor-self-test', password: 'hash', role: 'instructor', studioId: studioA.id });
  const staffB = await models.User.create({ username: 'instructor-b-cross-studio', password: 'hash', role: 'instructor', studioId: studioB.id });
  await models.MemberMeasurement.create({ memberId: memberA.id, studioId: studioA.id, measuredAt: '2026-08-01T10:00:00.000Z', height: 175, weight: 72, notes: 'staff only', createdByUserId: staff.id });
  await models.MemberMeasurement.create({ memberId: memberA.id, studioId: studioA.id, measuredAt: '2026-08-02T10:00:00.000Z', height: 176, weight: 71, notes: 'latest internal note', createdByUserId: staff.id });
  await models.MemberMeasurement.create({ memberId: memberB.id, studioId: studioB.id, measuredAt: '2026-08-03T10:00:00.000Z', height: 180, weight: 80, studioId: studioB.id });
  const attendanceA = await models.Attendance.create({ memberId: memberA.id, studioId: studioA.id, salonId: salonA.id, date: '2026-08-28 18:00:00', reservationId: reservationA.id, instructorId: staff.id });
  await models.Attendance.create({ memberId: memberA.id, studioId: studioA.id, salonId: salonA.id, date: '2026-08-27 17:00:00', reservationId: null, instructorId: 99999 });
  const paymentMethodA = await models.PaymentMethod.create({ name: 'Card A', studioId: studioA.id });
  await models.Payment.create({ memberId: memberA.id, studioId: studioA.id, paymentMethodId: paymentMethodA.id, amount: 500, date: '2026-08-20' });
  await models.Payment.create({ memberId: memberB.id, studioId: studioB.id, paymentMethodId: paymentMethodA.id, amount: 999, date: '2026-08-21' });

  const before = {
    member: JSON.stringify((await models.Member.findByPk(memberA.id)).toJSON()),
    measurements: await models.MemberMeasurement.count(),
    reservations: await models.Reservation.count(),
    attendances: await models.Attendance.count(),
    packages: await models.MemberLessonPackage.count(),
    payments: await models.Payment.count(),
    users: await models.User.count(),
    assignmentId: assignmentA.id,
    attendanceId: attendanceA.id,
  };
  const reqA = contextRequest(account.id, membershipA.id, studioA.id, memberA.id);

  const self = await run(controller.getSelf, { ...reqA, query: { memberId: memberB.id, studioId: studioB.id } });
  assert.strictEqual(self.statusCode, 200);
  assert.strictEqual(self.body.member.id, memberA.id);
  assert.strictEqual(self.body.studio.id, studioA.id);
  assert.strictEqual(self.body.summary.remainingLessons, 7);
  assert.strictEqual(Number(self.body.summary.totalDebt), 1250.5);
  assert.strictEqual(self.body.summary.latestMeasurement.height, 176);
  assert.strictEqual(self.body.member.normalizedPhone, undefined);
  assert.strictEqual(self.body.member.assignedSalonIds, undefined);
  assert.strictEqual(self.body.summary.latestMeasurement.notes, undefined);
  assert.strictEqual(self.body.assignedInstructor, null);

  await memberA.update({ assignedInstructorId: staff.id });
  const selfWithInstructor = await run(controller.getSelf, reqA);
  assert.deepStrictEqual(selfWithInstructor.body.assignedInstructor, { id: staff.id, name: 'instructor-self-test' });
  assert.strictEqual(selfWithInstructor.body.assignedInstructor.password, undefined);
  assert.strictEqual(selfWithInstructor.body.assignedInstructor.role, undefined);
  assert.strictEqual(selfWithInstructor.body.assignedInstructor.permissions, undefined);
  assert.strictEqual(selfWithInstructor.body.assignedInstructor.studioId, undefined);

  await memberA.update({ assignedInstructorId: staffB.id });
  const selfCrossStudio = await run(controller.getSelf, reqA);
  assert.strictEqual(selfCrossStudio.body.assignedInstructor, null);

  await memberA.update({ assignedInstructorId: 999999 });
  const selfStaleInstructor = await run(controller.getSelf, reqA);
  assert.strictEqual(selfStaleInstructor.body.assignedInstructor, null);

  await memberA.update({ assignedInstructorId: null });

  const measurements = await run(controller.getMeasurements, reqA);
  assert.strictEqual(measurements.body.length, 2);
  assert.strictEqual(measurements.body[0].height, 176);
  assert.strictEqual(measurements.body[1].height, 175);
  assert.strictEqual(measurements.body[0].notes, undefined);
  assert.strictEqual(measurements.body[0].createdByUserId, undefined);

  const reservations = await run(controller.getReservations, { ...reqA, query: { memberId: memberB.id, studioId: studioB.id } });
  assert.strictEqual(reservations.body.length, 1);
  assert.strictEqual(reservations.body[0].id, reservationA.id);
  assert.strictEqual(reservations.body[0].salon.name, 'Salon A');
  assert.strictEqual(reservations.body[0].equipment.name, 'Mat A');
  const boundedReservations = await run(controller.getReservations, { ...reqA, query: { from: '2026-08-28', to: '2026-08-28', limit: 1 } });
  assert.strictEqual(boundedReservations.body.length, 1);
  assert.strictEqual((await run(controller.getReservations, { ...reqA, query: { limit: 101 } })).statusCode, 400);

  const packages = await run(controller.getPackages, { ...reqA, query: { memberId: memberB.id } });
  assert.strictEqual(Number(packages.body.remainingLessons), 7);
  assert.strictEqual(packages.body.packages.length, 1);
  assert.strictEqual(packages.body.packages[0].assignmentId, assignmentA.id);
  assert.strictEqual(packages.body.packages[0].name, 'Ten Lessons A');

  const attendances = await run(controller.getAttendances, { ...reqA, query: { studioId: studioB.id } });
  assert.strictEqual(attendances.body.length, 2);
  assert.strictEqual(attendances.body[0].id, attendanceA.id);
  assert.strictEqual(attendances.body[0].instructor.name, 'instructor-self-test');
  assert.strictEqual(attendances.body[1].salon.name, 'Salon A');
  assert.strictEqual(attendances.body[1].instructor, null);
  assert.strictEqual(attendances.body[0].payout, undefined);

  const payments = await run(controller.getPayments, { ...reqA, query: { studioId: studioB.id } });
  assert.strictEqual(Number(payments.body.totalDebt), 1250.5);
  assert.strictEqual(payments.body.payments.length, 1);
  assert.strictEqual(payments.body.payments[0].paymentMethod.name, 'Card A');
  assert.strictEqual(payments.body.payments[0].paymentMethod.id, undefined);

  const token = signMemberContextToken({ accountId: account.id, membershipId: membershipA.id, studioId: studioA.id, memberId: memberA.id });
  const middlewareRequest = { headers: { authorization: `Bearer ${token}` } };
  await new Promise((resolve, reject) => authenticateMemberContext(middlewareRequest, { status(code) { return { json() { reject(new Error(`unexpected ${code}`)); } }; } }, () => resolve()));
  assert.strictEqual(middlewareRequest.memberId, memberA.id);
  assert.strictEqual(middlewareRequest.memberStudioId, studioA.id);
  assert.strictEqual(middlewareRequest.user, undefined);

  const foreignContext = signMemberContextToken({ accountId: account.id, membershipId: membershipB.id, studioId: studioB.id, memberId: memberB.id });
  const foreignReq = { ...contextRequest(account.id, membershipB.id, studioB.id, memberB.id) };
  const selfB = await run(controller.getSelf, foreignReq);
  assert.strictEqual(selfB.body.member.id, memberB.id);
  assert.strictEqual(selfB.body.studio.id, studioB.id);
  assert.notStrictEqual(selfB.body.member.id, self.body.member.id);
  assert.ok(foreignContext);

  assert.strictEqual(
    JSON.stringify({ ...(await models.Member.findByPk(memberA.id)).toJSON(), updatedAt: undefined }),
    JSON.stringify({ ...JSON.parse(before.member), updatedAt: undefined })
  );
  assert.strictEqual(await models.MemberMeasurement.count(), before.measurements);
  assert.strictEqual(await models.Reservation.count(), before.reservations);
  assert.strictEqual(await models.Attendance.count(), before.attendances);
  assert.strictEqual(await models.MemberLessonPackage.count(), before.packages);
  assert.strictEqual(await models.Payment.count(), before.payments);
  assert.strictEqual(await models.User.count(), before.users);
  console.log('member self-service validation passed');
  await models.sequelize.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  cleanup();
});
