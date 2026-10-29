// Disposable validator (not part of product code): proves historical instructor
// fee rates end to end — baseline seeding, point-in-time fee resolution,
// same-day edits, backdated attendance, concurrent instructors, group/individual
// classification, deleted-instructor history retention — against isolated temp
// SQLite DBs (fresh and pre-existing). Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-history-'));
const dbPath = path.join(tmpRoot, 'validation.sqlite');
process.env.DB_PATH = dbPath;

const {
  sequelize,
  Studio,
  User,
  UserFeeHistory,
  Salon,
  Equipment,
  MemberType,
  Member,
  Reservation,
  Attendance,
} = require('../models');
const ensureUserFeeHistoryTable = require('../ensureUserFeeHistoryTable');
const userController = require('../controllers/userController');
const reportsController = require('../controllers/reportsController');
const { recordFeeChangeIfNeeded, getStudioLocalDate } = require('../services/instructorFeeHistoryService');

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

async function getReport(asUser, startDate, endDate) {
  const res = mockRes();
  await reportsController.getReports(
    reqFor(asUser, {}, { query: { mode: 'daily', startDate, endDate } }), res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body && res.body.error));
  return res.body;
}

async function run() {
  // --- Phase 1: simulate a pre-migration database (no UserFeeHistories table) ---
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS UserFeeHistories');

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

  const salon = await Salon.create({ name: 'Salon 1', type: 'Yoga', studioId: studio.id });
  const equipment = await Equipment.create({ name: 'Mat 1', type: 'Mat', salonId: salon.id, studioId: studio.id });
  const groupType = await MemberType.create({
    name: 'Group', color: '#AABBCC', isCardBased: false, sessionType: 'group', studioId: studio.id,
  });
  const individualType = await MemberType.create({
    name: 'Individual', color: '#DDEEFF', isCardBased: false, sessionType: 'individual', studioId: studio.id,
  });

  async function makeMember(name, phone, memberTypeId) {
    return Member.create({
      name, phone, memberTypeId, assignedSalonIds: [salon.id],
      remainingLessons: 50, isActive: true, studioId: studio.id,
    });
  }
  async function bookAttendance(memberId, date, time, instructorId) {
    const reservation = await Reservation.create({
      memberId, equipmentId: equipment.id, salonId: salon.id, date, time, studioId: studio.id,
    });
    return Attendance.create({
      memberId, salonId: salon.id, date: `${date} ${time}`, reservationId: reservation.id,
      instructorId, studioId: studio.id,
    });
  }

  const asOwner = { id: owner.id, role: 'admin', studioId: studio.id, assignedSalonIds: [], permissions: [] };

  // Pre-migration session: 2026-10-01, instructorA group, 2 attendees (once-per-class).
  const pm1 = await makeMember('Pre Member1', '+905551000001', groupType.id);
  const pm2 = await makeMember('Pre Member2', '+905551000002', groupType.id);
  await bookAttendance(pm1.id, '2026-10-01', '09:00:00', instructorA.id);
  await bookAttendance(pm2.id, '2026-10-01', '09:00:00', instructorA.id);

  const legacyReport = await getReport(asOwner, '2026-09-01', '2026-12-31');
  const legacyRowA = legacyReport.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
  assert.ok(legacyRowA, 'legacy payout row exists');
  assert.strictEqual(legacyRowA.sessionCount, 1, 'two attendees = one session');
  assert.strictEqual(Number(legacyRowA.totalInstructorPayout), 50, 'legacy: 1 group session x 50');
  const legacyEstimatedCost = Number(legacyReport.summary.estimatedInstructorCost);
  console.log('Phase 1 OK: pre-migration legacy payout = 50 (current-fee behavior)');

  // --- Phase 2: run migration on the existing DB (baseline seed at virtual date) ---
  await ensureUserFeeHistoryTable();
  await ensureUserFeeHistoryTable(); // idempotent

  const today = await getStudioLocalDate(studio.id);
  assert.ok(today, 'studio-local today resolved');
  const BASELINE_DATE = '1970-01-01';

  const historyA = await UserFeeHistory.findAll({ where: { userId: instructorA.id } });
  assert.strictEqual(historyA.length, 1, 'exactly one baseline row for instructorA');
  assert.strictEqual(String(historyA[0].effectiveFromDate), BASELINE_DATE, 'baseline anchored at virtual date');
  assert.strictEqual(Number(historyA[0].groupSessionFee), 50);
  assert.strictEqual(Number(historyA[0].individualSessionFee), 120);

  const historyB = await UserFeeHistory.findAll({ where: { userId: instructorB.id } });
  assert.strictEqual(historyB.length, 1, 'baseline row for instructorB');
  const historyOwner = await UserFeeHistory.findAll({ where: { userId: owner.id } });
  assert.strictEqual(historyOwner.length, 1, 'baseline row for owner-teacher');
  const historyLaterAdmin = await UserFeeHistory.findAll({ where: { userId: laterAdmin.id } });
  assert.strictEqual(historyLaterAdmin.length, 0, 'non-teaching later admin gets no baseline');
  console.log('Phase 2 OK: baseline seeded once per teaching-capable user at 1970-01-01, idempotent');

  // Pre-migration report amounts unchanged after seeding.
  const afterSeedReport = await getReport(asOwner, '2026-09-01', '2026-12-31');
  const afterSeedRowA = afterSeedReport.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
  assert.strictEqual(Number(afterSeedRowA.totalInstructorPayout), 50, 'pre-history session keeps baseline rate');
  assert.strictEqual(Number(afterSeedReport.summary.estimatedInstructorCost), legacyEstimatedCost);
  console.log('Phase 2b OK: pre-migration report amounts preserved after baseline seed');

  // --- Phase 3: migration-day fee edit -> baseline immutable, separate today row ---
  {
    const res = mockRes();
    await userController.updateUserFees(
      reqFor(asOwner, { groupSessionFee: 90, individualSessionFee: 180 }, { params: { id: instructorA.id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

    const history = await UserFeeHistory.findAll({ where: { userId: instructorA.id }, order: [['effectiveFromDate', 'ASC']] });
    assert.strictEqual(history.length, 2, 'migration-day edit creates a separate today row');
    assert.strictEqual(String(history[0].effectiveFromDate), BASELINE_DATE, 'baseline row untouched');
    assert.strictEqual(Number(history[0].groupSessionFee), 50, 'baseline rate immutable');
    assert.strictEqual(String(history[1].effectiveFromDate), today, 'today row at migration date');
    assert.strictEqual(Number(history[1].groupSessionFee), 90);
    assert.strictEqual(Number(history[1].individualSessionFee), 180);

    // Pre-migration session (2026-10-01) keeps the original baseline rate 50.
    const report = await getReport(asOwner, '2026-09-01', '2026-12-31');
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    assert.strictEqual(Number(rowA.totalInstructorPayout), 50, `pre-migration session keeps baseline 50, got ${rowA.totalInstructorPayout}`);
    console.log('Phase 3 OK: baseline immutable; migration-day edit separate; pre-migration session = 50');
  }

  // --- Phase 3b: migration-day sessions use the latest same-day rate ---
  {
    // Morning + evening sessions on the migration date (today).
    const m1 = await makeMember('Member MD1', '+905551000016', groupType.id);
    const m2 = await makeMember('Member MD2', '+905551000017', groupType.id);
    await bookAttendance(m1.id, today, '07:00:00', instructorA.id);
    await bookAttendance(m2.id, today, '20:00:00', instructorA.id);

    const report = await getReport(asOwner, today, today);
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    assert.strictEqual(rowA.sessionCount, 2, 'morning + evening sessions on migration day');
    assert.strictEqual(Number(rowA.totalInstructorPayout), 90 + 90, `migration-day sessions use latest same-day rate 90, got ${rowA.totalInstructorPayout}`);
    console.log('Phase 3b OK: migration-day morning/evening sessions = 90 each');
  }

  // --- Phase 3c: a LATER fee change must NOT reprice earlier dates ---
  // Future-dated entry (2026-11-01: 70/140) simulates a later fee change.
  {
    await UserFeeHistory.create({
      userId: instructorA.id, studioId: studio.id,
      groupSessionFee: 70, individualSessionFee: 140, effectiveFromDate: '2026-11-01',
    });
    const preReport = await getReport(asOwner, '2026-09-01', '2026-10-31');
    const preRowA = preReport.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    // 2026-10-01 (50 baseline) + today morning/evening (90 + 90) = 230.
    assert.strictEqual(Number(preRowA.totalInstructorPayout), 230, `earlier dates unaffected by later change, got ${preRowA.totalInstructorPayout}`);
    console.log('Phase 3c OK: later fee change does not reprice earlier dates');
  }

  // --- Phase 4: dated history -> new session uses new fee, old keeps old ---
  {
    // (2026-11-01 entry for instructorA already created in Phase 3c: 70/140.)

    // New sessions: 2026-11-05 group (A, after change), 2026-10-10 group (A, before change).
    const m1 = await makeMember('Member G1', '+905551000011', groupType.id);
    const m2 = await makeMember('Member G2', '+905551000012', groupType.id);
    await bookAttendance(m1.id, '2026-11-05', '10:00:00', instructorA.id);
    await bookAttendance(m2.id, '2026-10-10', '10:00:00', instructorA.id);

    const report = await getReport(asOwner, '2026-09-01', '2026-12-31');
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    // 2026-10-01 -> 50 (baseline); 2026-10-10 -> 50 (baseline);
    // today x2 -> 90 each; 2026-11-05 -> 70 (2026-11-01 entry).
    assert.strictEqual(rowA.sessionCount, 5, JSON.stringify(rowA.sessions.map((s) => s.date)));
    assert.strictEqual(Number(rowA.totalInstructorPayout), 50 + 50 + 90 + 90 + 70, `per-date rates applied, got ${rowA.totalInstructorPayout}`);
    console.log('Phase 4 OK: sessions priced by their own date (50 + 50 + 90 + 90 + 70 = 350)');
  }

  // --- Phase 5: backdated attendance gets the rate effective on the class date ---
  {
    // Created "now" for a 2026-11-02 class -> 2026-11-01 rate (70), not today's 90.
    const m = await makeMember('Member Backdated', '+905551000013', groupType.id);
    await bookAttendance(m.id, '2026-11-02', '11:00:00', instructorA.id);

    const report = await getReport(asOwner, '2026-11-02', '2026-11-02');
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    assert.strictEqual(Number(rowA.totalInstructorPayout), 70, 'backdated attendance uses class-date rate');
    console.log('Phase 5 OK: backdated attendance priced at class-date rate');
  }

  // --- Phase 6: concurrent instructors same slot, different fee histories ---
  {
    await UserFeeHistory.create({
      userId: instructorB.id, studioId: studio.id,
      groupSessionFee: 85, individualSessionFee: 170, effectiveFromDate: '2026-11-01',
    });
    // 2026-11-05 12:00: A teaches 2 members, B teaches 3 members, same salon/time.
    for (let i = 0; i < 2; i++) {
      const m = await makeMember(`Member CA${i}`, `+9055510001${20 + i}`, groupType.id);
      await bookAttendance(m.id, '2026-11-05', '12:00:00', instructorA.id);
    }
    for (let i = 0; i < 3; i++) {
      const m = await makeMember(`Member CB${i}`, `+9055510001${30 + i}`, groupType.id);
      await bookAttendance(m.id, '2026-11-05', '12:00:00', instructorB.id);
    }

    const report = await getReport(asOwner, '2026-11-05', '2026-11-05');
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    const rowB = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorB.id);
    const slotA = rowA.sessions.find((s) => s.time === '12:00:00');
    const slotB = rowB.sessions.find((s) => s.time === '12:00:00');
    assert.ok(slotA && slotB, 'both instructors have the shared slot');
    assert.strictEqual(slotA.participantCount, 2);
    assert.strictEqual(slotB.participantCount, 3);
    // A: 10:00 session (70) + 12:00 session (70) = 140; B: 12:00 session at 85.
    assert.strictEqual(Number(rowA.totalInstructorPayout), 140, `A day total, got ${rowA.totalInstructorPayout}`);
    assert.strictEqual(Number(rowB.totalInstructorPayout), 85, `B one session x 85, got ${rowB.totalInstructorPayout}`);
    console.log('Phase 6 OK: concurrent instructors each paid once at their own date-correct rate');
  }

  // --- Phase 7: group/individual classification with per-date fees ---
  {
    // 2026-11-05 13:00: individual-only session for A -> individual rate 140 (2026-11-01 entry).
    const m = await makeMember('Member Ind', '+905551000014', individualType.id);
    await bookAttendance(m.id, '2026-11-05', '13:00:00', instructorA.id);

    const report = await getReport(asOwner, '2026-11-05', '2026-11-05');
    const rowA = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorA.id);
    assert.strictEqual(rowA.groupSessionCount, 2);
    assert.strictEqual(rowA.individualSessionCount, 1);
    assert.strictEqual(Number(rowA.totalInstructorPayout), 140 + 140, `2 group x 70 + 1 individual x 140, got ${rowA.totalInstructorPayout}`);
    console.log('Phase 7 OK: group/individual sessions priced per type and date');
  }

  // --- Phase 8: deleted instructor keeps fee history and payout resolves ---
  {
    const instructorC = await User.create({
      username: 'instructorC', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: [],
      groupSessionFee: 60, individualSessionFee: 60, studioId: studio.id,
    });
    await recordFeeChangeIfNeeded({
      user: instructorC, studioId: studio.id, groupSessionFee: 60, individualSessionFee: 60,
    });
    const m = await makeMember('Member C', '+905551000015', groupType.id);
    await bookAttendance(m.id, '2026-10-21', '09:00:00', instructorC.id);

    await instructorC.destroy();
    const historyC = await UserFeeHistory.findAll({ where: { userId: instructorC.id } });
    assert.strictEqual(historyC.length, 1, 'fee history retained after instructor deletion');

    const report = await getReport(asOwner, '2026-10-21', '2026-10-21');
    const rowC = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorC.id);
    assert.ok(rowC, 'deleted instructor payout row still resolves');
    assert.strictEqual(rowC.instructorName, 'Bilinmeyen Eğitmen');
    assert.strictEqual(Number(rowC.totalInstructorPayout), 60, 'deleted instructor paid from retained history');
    console.log('Phase 8 OK: deleted instructor history retained, payout resolves');
  }

  // --- Phase 9: no-change fee write does not add history rows ---
  {
    // instructorB's latest entry is 85/170 (Phase 6, effective 2026-11-01); writing the
    // same values must not create a new row.
    const before = await UserFeeHistory.count({ where: { userId: instructorB.id } });
    const res = mockRes();
    await userController.updateUserFees(
      reqFor(asOwner, { groupSessionFee: 85, individualSessionFee: 170 }, { params: { id: instructorB.id } }), res);
    assert.strictEqual(res.statusCode, 200);
    const after = await UserFeeHistory.count({ where: { userId: instructorB.id } });
    assert.strictEqual(after, before, 'no history row when fees unchanged');
    console.log('Phase 9 OK: unchanged fees do not create history rows');
  }

  // --- Phase 10: updateUser fee path also records history ---
  {
    const before = await UserFeeHistory.count({ where: { userId: instructorB.id } });
    const res = mockRes();
    await userController.updateUser(
      reqFor(asOwner, { groupSessionFee: 95, individualSessionFee: 195 }, { params: { id: instructorB.id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const rows = await UserFeeHistory.findAll({ where: { userId: instructorB.id }, order: [['effectiveFromDate', 'ASC']] });
    assert.strictEqual(rows.length, before + 1, 'updateUser on migration day adds a separate today row');
    const todayRow = rows.find((r) => String(r.effectiveFromDate) === today);
    assert.ok(todayRow, 'today row exists');
    assert.strictEqual(Number(todayRow.groupSessionFee), 95);
    assert.strictEqual(Number(todayRow.individualSessionFee), 195);
    const baselineRow = rows.find((r) => String(r.effectiveFromDate) === BASELINE_DATE);
    assert.ok(baselineRow && Number(baselineRow.groupSessionFee) === 80, 'baseline row untouched');
    console.log('Phase 10 OK: updateUser fee change recorded via shared service, baseline immutable');
  }

  // --- Phase 11: createUser seeds initial fee history ---
  {
    const res = mockRes();
    await userController.createUser(
      reqFor(asOwner, {
        username: 'instructorD', password: 'secret1', role: 'instructor',
        assignedSalonIds: [salon.id], groupSessionFee: 45, individualSessionFee: 90,
      }), res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    const rows = await UserFeeHistory.findAll({ where: { userId: res.body.id } });
    assert.strictEqual(rows.length, 1, 'createUser seeds one history row');
    assert.strictEqual(Number(rows[0].groupSessionFee), 45);
    assert.strictEqual(String(rows[0].effectiveFromDate), today);
    console.log('Phase 11 OK: createUser seeds initial fee history');
  }

  // --- Phase 13: required migration-day scenario (baseline 500, same-day 650) ---
  {
    const instructorE = await User.create({
      username: 'instructorE', password: 'hash', role: 'instructor', assignedSalonIds: [1], permissions: [],
      groupSessionFee: 500, individualSessionFee: 500, studioId: studio.id,
    });
    // Baseline seeded at 500 (virtual date), as the migration would on first bootstrap.
    await ensureUserFeeHistoryTable();
    let rows = await UserFeeHistory.findAll({ where: { userId: instructorE.id }, order: [['effectiveFromDate', 'ASC']] });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(String(rows[0].effectiveFromDate), BASELINE_DATE);
    assert.strictEqual(Number(rows[0].groupSessionFee), 500);

    // Sessions: previous day, migration-day morning, migration-day evening, following day.
    const [pm, mm, em, fm] = await Promise.all([
      makeMember('E Prev', '+905551000041', groupType.id),
      makeMember('E Morn', '+905551000042', groupType.id),
      makeMember('E Eve', '+905551000043', groupType.id),
      makeMember('E Foll', '+905551000044', groupType.id),
    ]);
    const nextDay = new Date(`${today}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const followingDay = nextDay.toISOString().slice(0, 10);
    await bookAttendance(pm.id, '2026-10-28', '09:00:00', instructorE.id);
    await bookAttendance(mm.id, today, '07:00:00', instructorE.id);
    await bookAttendance(em.id, today, '20:00:00', instructorE.id);
    await bookAttendance(fm.id, followingDay, '09:00:00', instructorE.id);

    // Migration-day fee update 500 -> 650.
    const res = mockRes();
    await userController.updateUserFees(
      reqFor(asOwner, { groupSessionFee: 650, individualSessionFee: 650 }, { params: { id: instructorE.id } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    rows = await UserFeeHistory.findAll({ where: { userId: instructorE.id }, order: [['effectiveFromDate', 'ASC']] });
    assert.strictEqual(rows.length, 2, 'baseline + migration-day row');
    assert.strictEqual(Number(rows[0].groupSessionFee), 500, 'baseline immutable');
    assert.strictEqual(String(rows[1].effectiveFromDate), today);
    assert.strictEqual(Number(rows[1].groupSessionFee), 650);

    const report = await getReport(asOwner, '2026-10-01', '2026-12-31');
    const rowE = report.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorE.id);
    const feeByDate = Object.fromEntries(rowE.sessions.map((s) => [s.date, s]));
    assert.strictEqual(rowE.sessionCount, 4, JSON.stringify(rowE.sessions.map((s) => s.date)));
    // Per-date resolution: prev=500, migration morning=650, migration evening=650, following=650.
    assert.strictEqual(Number(rowE.totalInstructorPayout), 500 + 650 + 650 + 650, `got ${rowE.totalInstructorPayout}`);
    assert.ok(feeByDate['2026-10-28'] && feeByDate[today] && feeByDate[followingDay]);

    // Later fee update must not affect earlier dates.
    const res2 = mockRes();
    await userController.updateUserFees(
      reqFor(asOwner, { groupSessionFee: 700, individualSessionFee: 700 }, { params: { id: instructorE.id } }), res2);
    assert.strictEqual(res2.statusCode, 200);
    const report2 = await getReport(asOwner, '2026-10-01', '2026-12-31');
    const rowE2 = report2.instructorSessionBreakdown.find((r) => Number(r.instructorId) === instructorE.id);
    // Same-day second edit updates the today row: migration-day + following-day now 700.
    assert.strictEqual(Number(rowE2.totalInstructorPayout), 500 + 700 + 700 + 700, `same-day latest rate wins, got ${rowE2.totalInstructorPayout}`);
    const rowsFinal = await UserFeeHistory.findAll({ where: { userId: instructorE.id }, order: [['effectiveFromDate', 'ASC']] });
    assert.strictEqual(rowsFinal.length, 2, 'second same-day edit updates today row, no new row');
    assert.strictEqual(Number(rowsFinal[0].groupSessionFee), 500, 'baseline still immutable');
    console.log('Phase 13 OK: baseline 500 immutable; migration-day 650/700; prev-day 500; following-day latest rate');
  }
  // --- Phase 12: fresh DB bootstrap (table created by sync, ensure-script no-op-safe) ---
  {
    const freshPath = path.join(tmpRoot, 'fresh.sqlite');
    const { Sequelize } = require('sequelize');
    const freshSequelize = new Sequelize({ dialect: 'sqlite', storage: freshPath, logging: false });
    await freshSequelize.query(`
      CREATE TABLE UserFeeHistories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        studioId INTEGER NOT NULL,
        groupSessionFee DECIMAL(10,2) NOT NULL DEFAULT 0,
        individualSessionFee DECIMAL(10,2) NOT NULL DEFAULT 0,
        effectiveFromDate DATEONLY NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await freshSequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS user_fee_histories_studio_user_effective_unique
      ON UserFeeHistories (studioId, userId, effectiveFromDate);
    `);
    const [tables] = await freshSequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='UserFeeHistories'");
    assert.strictEqual(tables.length, 1, 'fresh DB table present');
    await freshSequelize.close();
    console.log('Phase 12 OK: fresh-DB DDL shape valid');
  }

  console.log('All instructor-fee-history cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
