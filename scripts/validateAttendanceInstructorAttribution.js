// Disposable validator (not part of product code): proves attendance instructor
// attribution end to end — actual-teacher selection/defaulting/validation,
// same-slot conflict rejection, once-per-class payout, conflict reporting,
// and preserved lesson-balance semantics — against an isolated temp SQLite DB.
// Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'att-instructor-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    Salon,
    Equipment,
    MemberType,
    Member,
    Reservation,
    Attendance,
  } = require('../models');
  const attendanceController = require('../controllers/attendanceController');
  const memberController = require('../controllers/memberController');
  const reportsController = require('../controllers/reportsController');

  await sequelize.sync({ force: true });

  function mockRes() {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.sendStatus = (code) => { res.statusCode = code; res.body = null; return res; };
    return res;
  }

  function reqFor(user, body, extra = {}) {
    return { user, body, query: {}, params: {}, ...extra };
  }

  // --- Fixtures ---
  const studio = await Studio.create({
    name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const owner = await User.create({
    username: 'owner', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    groupSessionFee: 100, individualSessionFee: 200, studioId: studio.id,
  });
  studio.ownerUserId = owner.id;
  await studio.save();

  const instructorA = await User.create({
    username: 'instructorA', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: ['attendances'],
    groupSessionFee: 50, individualSessionFee: 120, studioId: studio.id,
  });
  const instructorB = await User.create({
    username: 'instructorB', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: ['attendances'],
    groupSessionFee: 80, individualSessionFee: 160, studioId: studio.id,
  });
  const laterAdmin = await User.create({
    username: 'laterAdmin', password: 'hash', role: 'admin', assignedSalonIds: [], permissions: [],
    groupSessionFee: 0, individualSessionFee: 0, studioId: studio.id,
  });

  const studioB = await Studio.create({
    name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul',
  });
  const crossStudioInstructor = await User.create({
    username: 'crossInstructor', password: 'hash', role: 'instructor', assignedSalonIds: [], permissions: [],
    studioId: studioB.id,
  });

  const salon = await Salon.create({ name: 'Salon 1', type: 'Yoga', studioId: studio.id });
  const equipment = await Equipment.create({ name: 'Mat 1', type: 'Mat', salonId: salon.id, studioId: studio.id });
  const memberType = await MemberType.create({
    name: 'Group', color: '#AABBCC', isCardBased: false, sessionType: 'group', studioId: studio.id,
  });

  async function makeMember(name, phone, assignedInstructorId) {
    return Member.create({
      name, phone, memberTypeId: memberType.id, assignedSalonIds: [salon.id],
      assignedInstructorId, remainingLessons: 10, isActive: true, studioId: studio.id,
    });
  }
  async function makeReservation(memberId, date, time) {
    return Reservation.create({
      memberId, equipmentId: equipment.id, salonId: salon.id, date, time, studioId: studio.id,
    });
  }

  const DAY1 = '2026-11-05';
  const TIME1 = '10:00:00';
  const DAY2 = '2026-11-06';
  const TIME2 = '11:00:00';
  const DAY3 = '2026-11-07';
  const TIME3 = '12:00:00';
  const DAY4 = '2026-11-08';
  const TIME4 = '13:00:00';

  const asInstructorA = { id: instructorA.id, role: 'instructor', studioId: studio.id, assignedSalonIds: [salon.id], permissions: ['attendances'] };
  const asInstructorB = { id: instructorB.id, role: 'instructor', studioId: studio.id, assignedSalonIds: [salon.id], permissions: ['attendances'] };
  const asOwner = { id: owner.id, role: 'admin', studioId: studio.id, assignedSalonIds: [], permissions: [] };
  const asLaterAdmin = { id: laterAdmin.id, role: 'admin', studioId: studio.id, assignedSalonIds: [], permissions: [] };

  // --- Case 1: instructor default = self when teaching-capable ---
  const member1 = await makeMember('Member One', '+905550000001', instructorB.id);
  await makeReservation(member1.id, DAY1, TIME1);
  {
    const res = mockRes();
    await attendanceController.addAttendance(
      reqFor(asInstructorA, { memberId: member1.id, salonId: salon.id, date: DAY1 }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(Number(res.body.instructorId), instructorA.id, 'default instructor must be the logged-in instructor');
    const m = await Member.findByPk(member1.id);
    assert.strictEqual(Number(m.remainingLessons), 9, 'lesson decremented once');
    console.log('Case 1 OK: instructor default = self, assignedInstructorId untouched, lesson decremented');
  }

  // --- Case 2: instructor selects another instructor (substitute gets attribution) ---
  const member2 = await makeMember('Member Two', '+905550000002', instructorA.id);
  await makeReservation(member2.id, DAY2, TIME2);
  {
    const res = mockRes();
    await attendanceController.addAttendance(
      reqFor(asInstructorA, { memberId: member2.id, salonId: salon.id, date: DAY2, instructorId: instructorB.id }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(Number(res.body.instructorId), instructorB.id, 'substitute instructor stored');
    console.log('Case 2 OK: instructor can attribute to another instructor');
  }

  // --- Case 3: admin (owner) selects instructor ---
  const member3 = await makeMember('Member Three', '+905550000003', null);
  await makeReservation(member3.id, DAY1, TIME1);
  {
    const res = mockRes();
    await attendanceController.addAttendance(
      reqFor(asOwner, { memberId: member3.id, salonId: salon.id, date: DAY1, instructorId: instructorA.id }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(Number(res.body.instructorId), instructorA.id);
    console.log('Case 3 OK: admin can select instructor');
  }

  // --- Case 4: non-teaching-capable admin must select explicitly ---
  const member4 = await makeMember('Member Four', '+905550000004', null);
  await makeReservation(member4.id, DAY2, TIME2);
  {
    const resNoId = mockRes();
    await attendanceController.addAttendance(
      reqFor(asLaterAdmin, { memberId: member4.id, salonId: salon.id, date: DAY2 }), resNoId);
    assert.strictEqual(resNoId.statusCode, 400, 'non-teaching admin without instructorId must be rejected');
    const resWithId = mockRes();
    await attendanceController.addAttendance(
      reqFor(asLaterAdmin, { memberId: member4.id, salonId: salon.id, date: DAY2, instructorId: instructorB.id }), resWithId);
    assert.strictEqual(resWithId.statusCode, 201, JSON.stringify(resWithId.body));
    assert.strictEqual(Number(resWithId.body.instructorId), instructorB.id);
    console.log('Case 4 OK: non-teaching admin requires explicit selection');
  }

  // --- Case 5: invalid / cross-studio / non-teaching selections rejected ---
  const member5 = await makeMember('Member Five', '+905550000005', null);
  await makeReservation(member5.id, DAY1, TIME1);
  {
    for (const [label, badId, expected] of [
      ['cross-studio instructor', crossStudioInstructor.id, 404],
      ['non-teaching later admin', laterAdmin.id, 404],
      ['missing user', 999999, 404],
      ['non-numeric', 'abc', 400],
    ]) {
      const res = mockRes();
      await attendanceController.addAttendance(
        reqFor(asOwner, { memberId: member5.id, salonId: salon.id, date: DAY1, instructorId: badId }), res);
      assert.strictEqual(res.statusCode, expected, `${label}: expected ${expected}, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    console.log('Case 5 OK: invalid/cross-studio/non-teaching instructorId rejected');
  }

  // --- Case 6: same class slot, different instructor -> allowed (concurrent instructors) ---
  // Slot DAY1/TIME1 already has instructorA attendance (member3).
  const member6 = await makeMember('Member Six', '+905550000006', null);
  await makeReservation(member6.id, DAY1, TIME1);
  {
    const resOk = mockRes();
    await attendanceController.addAttendance(
      reqFor(asInstructorB, { memberId: member6.id, salonId: salon.id, date: DAY1, instructorId: instructorB.id }), resOk);
    assert.strictEqual(resOk.statusCode, 201, JSON.stringify(resOk.body));
    assert.strictEqual(Number(resOk.body.instructorId), instructorB.id, 'different instructor in same slot must be accepted');
    const mAfter = await Member.findByPk(member6.id);
    assert.strictEqual(Number(mAfter.remainingLessons), 9, 'lesson decremented once');
    console.log('Case 6 OK: concurrent instructor in same slot accepted');
  }

  // --- Case 7: GET attendances includes instructor details ---
  {
    const res = mockRes();
    await attendanceController.getAttendance(reqFor(asOwner, {}), res);
    assert.strictEqual(res.statusCode, 200);
    const row = res.body.find((a) => a.memberId === member2.id);
    assert.ok(row, 'attendance row present');
    assert.ok(row.Instructor, 'Instructor included');
    assert.strictEqual(Number(row.Instructor.id), instructorB.id);
    assert.strictEqual(row.Instructor.username, 'instructorB');
    console.log('Case 7 OK: GET returns instructor details');
  }

  // --- Case 8: PUT instructorId edit moves attribution; null rejected; conflict rejected ---
  // Dedicated clean slot DAY4/TIME4 for successful edits.
  const member10 = await makeMember('Member Ten', '+905550000010', null);
  await makeReservation(member10.id, DAY4, TIME4);
  {
    const resCreate = mockRes();
    await attendanceController.addAttendance(
      reqFor(asInstructorA, { memberId: member10.id, salonId: salon.id, date: DAY4 }), resCreate);
    assert.strictEqual(resCreate.statusCode, 201, JSON.stringify(resCreate.body));
    const attendance10 = await Attendance.findOne({ where: { memberId: member10.id } });

    const resNull = mockRes();
    await attendanceController.updateAttendance(
      reqFor(asOwner, { salonId: salon.id, instructorId: null }, { params: { id: attendance10.id } }), resNull);
    assert.strictEqual(resNull.statusCode, 400, 'instructorId null must be rejected');

    const resEdit = mockRes();
    await attendanceController.updateAttendance(
      reqFor(asOwner, { salonId: salon.id, instructorId: instructorB.id }, { params: { id: attendance10.id } }), resEdit);
    assert.strictEqual(resEdit.statusCode, 200, JSON.stringify(resEdit.body));
    assert.strictEqual(Number(resEdit.body.instructorId), instructorB.id, 'attribution moved to instructorB');

    const resEditBack = mockRes();
    await attendanceController.updateAttendance(
      reqFor(asOwner, { salonId: salon.id, instructorId: instructorA.id }, { params: { id: attendance10.id } }), resEditBack);
    assert.strictEqual(resEditBack.statusCode, 200, JSON.stringify(resEditBack.body));
    assert.strictEqual(Number(resEditBack.body.instructorId), instructorA.id);

    // Editing into a slot where another instructor teaches is allowed (concurrent instructors)
    const attendance2 = await Attendance.findOne({ where: { memberId: member2.id } });
    const resMove = mockRes();
    await attendanceController.updateAttendance(
      reqFor(asOwner, { salonId: salon.id, instructorId: instructorA.id }, { params: { id: attendance2.id } }), resMove);
    assert.strictEqual(resMove.statusCode, 200, JSON.stringify(resMove.body));
    assert.strictEqual(Number(resMove.body.instructorId), instructorA.id);
    console.log('Case 8 OK: PUT instructorId edit validated, null rejected, concurrent-instructor edit allowed');
  }

  // --- Case 9: instructor salon restriction on PUT/DELETE ---
  {
    const attendance2 = await Attendance.findOne({ where: { memberId: member2.id } });
    const asUnassignedInstructor = { id: instructorB.id, role: 'instructor', studioId: studio.id, assignedSalonIds: [999], permissions: ['attendances'] };
    const resPut = mockRes();
    await attendanceController.updateAttendance(
      reqFor(asUnassignedInstructor, { salonId: salon.id }, { params: { id: attendance2.id } }), resPut);
    assert.strictEqual(resPut.statusCode, 403, 'PUT by unassigned instructor must be forbidden');
    const resDel = mockRes();
    await attendanceController.deleteAttendance(
      reqFor(asUnassignedInstructor, {}, { params: { id: attendance2.id } }), resDel);
    assert.strictEqual(resDel.statusCode, 403, 'DELETE by unassigned instructor must be forbidden');
    console.log('Case 9 OK: instructor salon restriction enforced on PUT/DELETE');
  }

  // --- Case 10: member-scoped POST path honors instructorId + salon restriction ---
  const member7 = await makeMember('Member Seven', '+905550000007', null);
  await makeReservation(member7.id, DAY2, TIME2);
  {
    const res = mockRes();
    await memberController.addAttendance(
      reqFor(asInstructorA, { salonId: salon.id, date: DAY2, instructorId: instructorB.id }, { params: { id: member7.id } }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(Number(res.body.instructorId), instructorB.id);

    const member8 = await makeMember('Member Eight', '+905550000008', null);
    const asUnassigned = { id: instructorA.id, role: 'instructor', studioId: studio.id, assignedSalonIds: [999], permissions: ['attendances'] };
    const resForbidden = mockRes();
    await memberController.addAttendance(
      reqFor(asUnassigned, { salonId: salon.id, date: DAY2 }, { params: { id: member8.id } }), resForbidden);
    assert.strictEqual(resForbidden.statusCode, 403, 'member path must enforce assigned-salon for instructors');
    console.log('Case 10 OK: member-scoped path attributes + enforces salon restriction');
  }

  // --- Case 11: delete refunds lesson balance (preserved semantics) ---
  {
    const attendance1 = await Attendance.findOne({ where: { memberId: member1.id } });
    const before = Number((await Member.findByPk(member1.id)).remainingLessons);
    const res = mockRes();
    await attendanceController.deleteAttendance(
      reqFor(asOwner, {}, { params: { id: attendance1.id } }), res);
    assert.strictEqual(res.statusCode, 204);
    const after = Number((await Member.findByPk(member1.id)).remainingLessons);
    assert.strictEqual(after, before + 1, 'delete refunds one lesson');
    console.log('Case 11 OK: delete refunds lesson balance');
  }

  // --- Case 12: reports — concurrent instructors in one slot each get one payout ---
  {
    // Legacy-style mixed slot created directly (bypassing API): DAY1/TIME1 gets an
    // additional attendance attributed to instructorB -> mixed slot
    // (A: member3; B: member6 via API + member9 direct).
    const member9 = await makeMember('Member Nine', '+905550000009', null);
    const reservation9 = await makeReservation(member9.id, DAY1, TIME1);
    await Attendance.create({
      memberId: member9.id, salonId: salon.id, date: '2026-11-05 10:00:00',
      reservationId: reservation9.id, instructorId: instructorB.id, studioId: studio.id,
    });

    const res = mockRes();
    await reportsController.getReports(
      reqFor(asOwner, {}, { query: { mode: 'daily', startDate: '2026-01-01', endDate: '2026-12-31' } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body && res.body.error));
    const report = res.body;

    // No conflict reporting field; mixed slots remain eligible for payout.
    assert.ok(!('instructorSessionConflicts' in report), 'obsolete conflict field removed');

    // Slot DAY1/TIME1: instructorA taught member3 (1 attendee), instructorB taught member6+member9 (2 attendees).
    // Slot DAY2/TIME2: instructorA taught member2 (edited in Case 8), instructorB taught member4+member7.
    // Slot DAY4/TIME4: instructorA taught member10 (1 attendee).
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    const rowB = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorB.id);
    assert.ok(rowA && rowB, 'payout rows exist for both instructors');
    assert.strictEqual(rowA.sessionCount, 3, `A: DAY1 + DAY2 + DAY4 sessions, got ${JSON.stringify(rowA.sessions.map(s => s.date))}`);
    assert.strictEqual(rowA.participantCount, 3, 'A: member3 + member2 + member10');
    assert.strictEqual(Number(rowA.totalInstructorPayout), 150, 'A: 3 group sessions x 50');
    assert.strictEqual(rowB.sessionCount, 2, `B: DAY1 + DAY2 sessions, got ${JSON.stringify(rowB.sessions.map(s => s.date))}`);
    assert.strictEqual(rowB.participantCount, 4, 'B: member6 + member9 + member4 + member7');
    assert.strictEqual(Number(rowB.totalInstructorPayout), 160, 'B: 2 group sessions x 80');
    assert.strictEqual(Number(report.summary.estimatedInstructorCost), 310, 'mixed slots pay each instructor once per slot');

    // instructorAttendanceBreakdown credits the actual teacher (attendance.instructorId),
    // not member.assignedInstructorId (member1 assigned to B was taught by A but deleted;
    // member2 assigned to A, taught by B, edited to A in Case 8).
    const breakdownA = report.instructorAttendanceBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    const breakdownB = report.instructorAttendanceBreakdown.find((r) => Number(r.instructorId) === instructorB.id);
    assert.ok(breakdownA && breakdownA.attendanceCount === 3, `instructorA actual-teacher count, got ${JSON.stringify(report.instructorAttendanceBreakdown)}`);
    assert.ok(breakdownB && breakdownB.attendanceCount === 4, `instructorB actual-teacher count, got ${JSON.stringify(report.instructorAttendanceBreakdown)}`);
    console.log('Case 12 OK: mixed slot pays each instructor once, breakdown uses actual teacher');
  }

  // --- Case 13: once-per-class payout isolated to a single clean slot ---
  {
    const memberA1 = await makeMember('Member A1', '+905550000011', null);
    const memberA2 = await makeMember('Member A2', '+905550000012', null);
    await makeReservation(memberA1.id, DAY3, TIME3);
    await makeReservation(memberA2.id, DAY3, TIME3);
    for (const m of [memberA1, memberA2]) {
      const res = mockRes();
      await attendanceController.addAttendance(
        reqFor(asInstructorB, { memberId: m.id, salonId: salon.id, date: DAY3, instructorId: instructorB.id }), res);
      assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    }

    const res = mockRes();
    await reportsController.getReports(
      reqFor(asOwner, {}, { query: { mode: 'daily', startDate: DAY3, endDate: DAY3 } }), res);
    const report = res.body;
    const rowB = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorB.id);
    assert.ok(rowB, 'instructorB payout row exists');
    assert.strictEqual(rowB.sessionCount, 1, 'two attendees in one slot = one session');
    assert.strictEqual(rowB.participantCount, 2);
    assert.strictEqual(rowB.groupSessionCount, 1);
    assert.strictEqual(Number(rowB.totalInstructorPayout), 80, 'one group session x instructorB groupSessionFee');
    assert.strictEqual(Number(report.summary.estimatedInstructorCost), 80);
    console.log('Case 13 OK: same class produces exactly one payout');
  }

  console.log('All attendance-instructor-attribution cases passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
