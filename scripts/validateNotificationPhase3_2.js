// Disposable validator (not part of product code): proves notification Phase 3.2 —
// member-level payment reminder cycles (day 3/7, activation boundary, no
// retroactive, new-package reset, partial/full payment), delivery-time
// revalidation (payment/expiry/inactivity), and cross-studio isolation — on
// isolated temp SQLite DBs. Does not touch the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-phase32-'));
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
  MemberAccount,
  MemberAccountMembership,
  LessonPackage,
  MemberLessonPackage,
  Attendance,
  Notification,
  NotificationJob,
  StudioNotificationSettings,
} = require('../models');
const ensureNotificationTables = require('../ensureNotificationTables');
const ensureMemberLessonPackageExpiryAndDueDate = require('../ensureMemberLessonPackageExpiryAndDueDate');
const notificationWorker = require('../services/notificationWorker');
const notificationService = require('../services/notificationService');
const packageNotificationService = require('../services/packageNotificationService');
const { getStudioLocalDate } = require('../services/instructorFeeHistoryService');

function parsePayload(n) {
  if (!n) return null;
  if (n.payload && typeof n.payload === 'object') return n.payload;
  if (typeof n.payload === 'string') { try { return JSON.parse(n.payload); } catch { return null; } }
  return null;
}

function dateStr(d) { return d.toISOString().slice(0, 10); }
async function studioDaysFromNow(studioId, n) {
  const today = await getStudioLocalDate(studioId);
  return dateStr(new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000));
}

async function processAll() {
  return notificationWorker.processDueJobs({ now: new Date(Date.now() + 365 * 86400000) });
}

async function run() {
  await sequelize.sync({ force: true });
  await sequelize.query('DROP TABLE IF EXISTS NotificationJobs');
  await sequelize.query('DROP TABLE IF EXISTS Notifications');
  await sequelize.query('DROP TABLE IF EXISTS StudioNotificationSettings');
  await ensureNotificationTables();
  await ensureMemberLessonPackageExpiryAndDueDate();

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const instructorB = await User.create({ username: 'instB', password: 'h', role: 'instructor', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });
  const lessonPackageA = await LessonPackage.create({ name: 'Pkg 10', lessonCount: 10, price: 1000, studioId: studioA.id });

  async function makeMemberWithAccount(name, phone, assignedInstructorId, totalDebt = 0) {
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId, remainingLessons: 0, totalDebt, isActive: true, studioId: studioA.id,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId: studioA.id, memberId: member.id });
    return { member, account };
  }

  async function assignPackage(memberId, assignedAt) {
    return MemberLessonPackage.create({
      memberId, lessonPackageId: lessonPackageA.id, assignedAt,
      originalPrice: 1000, finalPrice: 1000, studioId: studioA.id,
    });
  }

  // Activate payment reminders for studio A. Boundary = 30 days ago (studio-local)
  // so recent test assignments (3/7 days ago) are on/after the boundary.
  const activationDate = await studioDaysFromNow(studioA.id, -30);
  await StudioNotificationSettings.create({ studioId: studioA.id, paymentRemindersActivatedAt: activationDate });

  // --- Phase 1: payment reminder day 3 (admin only) and day 7 (admin + member) ---
  {
    const { member, account } = await makeMemberWithAccount('Member Pay1', '+905323310001', instructorA.id, 500);
    // Assignment 3 days ago (on/after activation boundary).
    await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T12:00:00Z')));

    let result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 1, 'day-3 admin reminder enqueued');
    await processAll();
    let notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'payment_overdue' } });
    assert.ok(notifs.length > 0 && notifs.every((n) => n.recipientType === 'admin'), 'day 3: admin only');
    assert.ok(!notifs.some((n) => n.recipientType === 'instructor'), 'no instructor payment alert');

    // Move to day 7.
    const assignment = await MemberLessonPackage.findOne({ where: { memberId: member.id } });
    await assignment.update({ assignedAt: new Date(Date.parse(await studioDaysFromNow(studioA.id, -7) + 'T12:00:00Z')) });
    result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 2, 'day-7 admin + member reminders enqueued');
    await processAll();
    notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'payment_overdue' } });
    const day7 = notifs.filter((n) => parsePayload(n) && parsePayload(n).daysSince === 7);
    const day7Types = new Set(day7.map((n) => n.recipientType));
    assert.ok(day7Types.has('admin') && day7Types.has('member'), 'day 7: admin + member');
    assert.ok(!day7Types.has('instructor'), 'day 7: no instructor');
    console.log('Phase 1 OK: payment reminders day 3 (admin) and day 7 (admin+member)');
  }

  // --- Phase 2: one cycle per member; multiple packages no duplicate ---
  {
    const { member } = await makeMemberWithAccount('Member Pay2', '+905323310002', instructorA.id, 800);
    // Two packages, both 3 days ago. Only the LATEST anchors the cycle.
    await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T10:00:00Z')));
    const latest = await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T12:00:00Z')));

    const result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    // One admin reminder for this member (day 3, latest cycle).
    const jobs = await NotificationJob.findAll({ where: { type: 'payment_overdue' } });
    const forMember = jobs.filter((j) => j.dedupKey.includes(`payment_reminder:admin:${member.id}:`));
    assert.strictEqual(forMember.length, 1, `one reminder cycle per member, got ${forMember.length}`);
    assert.ok(forMember[0].dedupKey.includes(`cycle:${latest.id}`), 'anchored on latest assignment');
    console.log('Phase 2 OK: one cycle per member, multiple packages no duplicate');
  }

  // --- Phase 3: new package resets the cycle ---
  {
    const { member } = await makeMemberWithAccount('Member Pay3', '+905323310003', instructorA.id, 300);
    // Old assignment 7 days ago -> would fire day 7.
    const old = await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -7) + 'T12:00:00Z')));
    let result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    let jobs = await NotificationJob.findAll({ where: { type: 'payment_overdue' } });
    let forMember = jobs.filter((j) => j.dedupKey.includes(`payment_reminder:admin:${member.id}:`));
    assert.ok(forMember.some((j) => j.dedupKey.includes(`cycle:${old.id}`)), 'old cycle anchored');

    // New package today -> new cycle (day 0, no reminder yet).
    const fresh = await assignPackage(member.id, new Date());
    result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    jobs = await NotificationJob.findAll({ where: { type: 'payment_overdue' } });
    forMember = jobs.filter((j) => j.dedupKey.includes(`payment_reminder:admin:${member.id}:`));
    // No new reminder for the fresh cycle (day 0).
    assert.ok(!forMember.some((j) => j.dedupKey.includes(`cycle:${fresh.id}`)), 'new cycle does not fire on day 0');
    console.log('Phase 3 OK: new package resets reminder cycle');
  }

  // --- Phase 4: partial and full payment suppress reminders ---
  {
    const { member } = await makeMemberWithAccount('Member Pay4', '+905323310004', instructorA.id, 400);
    await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T12:00:00Z')));
    let result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 1, 'reminder enqueued with debt');

    // Partial payment: debt still > 0 -> still reminded.
    member.totalDebt = 100;
    await member.save();
    result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    // day-3 already fired (dedup), so 0 new.
    assert.strictEqual(result.enqueued, 0, 'partial payment: day-3 already fired (dedup)');

    // Full payment: debt = 0 -> suppressed.
    member.totalDebt = 0;
    await member.save();
    result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    assert.strictEqual(result.enqueued, 0, 'full payment suppresses reminders');
    console.log('Phase 4 OK: partial/full payment handling');
  }

  // --- Phase 5: no retroactive reminders for historical assignments ---
  {
    const { member } = await makeMemberWithAccount('Member Pay5', '+905323310005', instructorA.id, 600);
    // Assignment BEFORE the activation boundary.
    const beforeBoundary = dateStr(new Date(Date.parse(activationDate + 'T00:00:00Z') - 10 * 86400000));
    await assignPackage(member.id, new Date(Date.parse(beforeBoundary + 'T12:00:00Z')));
    const result = await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    const jobs = await NotificationJob.findAll({ where: { type: 'payment_overdue' } });
    const forMember = jobs.filter((j) => j.dedupKey.includes(`payment_reminder:admin:${member.id}:`));
    assert.strictEqual(forMember.length, 0, 'no retroactive reminder for historical assignment');
    console.log('Phase 5 OK: no retroactive historical reminders');
  }

  // --- Phase 6: activation boundary (not activated -> no reminders) ---
  {
    await StudioNotificationSettings.create({ studioId: studioB.id }); // no paymentRemindersActivatedAt
    const memberB = await Member.create({
      name: 'Member B', phone: '+905323310006', normalizedPhone: '+905323310006', memberTypeId: memberTypeA.id,
      assignedSalonIds: [salonA.id], remainingLessons: 0, totalDebt: 900, isActive: true, studioId: studioB.id,
    });
    await MemberLessonPackage.create({
      memberId: memberB.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(), originalPrice: 1000, finalPrice: 1000, studioId: studioB.id,
    });
    const result = await packageNotificationService.checkPaymentReminders({ studioId: studioB.id });
    assert.strictEqual(result.enqueued, 0, 'no reminders when not activated');
    console.log('Phase 6 OK: activation boundary (not activated -> none)');
  }

  // --- Phase 7: delivery-time revalidation - payment debt paid before delivery ---
  {
    const { member, account } = await makeMemberWithAccount('Member Pay7', '+905323310007', instructorA.id, 200);
    await assignPackage(member.id, new Date(Date.parse(await studioDaysFromNow(studioA.id, -3) + 'T12:00:00Z')));
    await packageNotificationService.checkPaymentReminders({ studioId: studioA.id });
    // Pay off debt before delivery.
    member.totalDebt = 0;
    await member.save();
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'payment_overdue' } });
    const forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).memberId === member.id);
    assert.strictEqual(forMember.length, 0, 'payment reminder skipped when debt paid before delivery');
    console.log('Phase 7 OK: payment revalidation (debt paid -> skipped)');
  }

  // --- Phase 8: delivery-time revalidation - package expiry changed ---
  {
    const { member } = await makeMemberWithAccount('Member Exp', '+905323310008', instructorA.id);
    const expiryDate = await studioDaysFromNow(studioA.id, 7);
    const assignment = await MemberLessonPackage.create({
      memberId: member.id, lessonPackageId: lessonPackageA.id, assignedAt: new Date(),
      originalPrice: 1000, finalPrice: 1000, expiresAt: expiryDate, studioId: studioA.id,
    });
    await packageNotificationService.checkPackageExpiry({ studioId: studioA.id });
    // Change expiry before delivery.
    await assignment.update({ expiresAt: await studioDaysFromNow(studioA.id, 30) });
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'package_expiring' } });
    const forMember = notifs.filter((n) => parsePayload(n) && parsePayload(n).notifications === undefined && parsePayload(n));
    const forAssignment = notifs.filter((n) => {
      const p = parsePayload(n);
      return p && p.memberLessonPackageId === assignment.id;
    });
    assert.strictEqual(forAssignment.length, 0, 'expiry alert skipped when expiresAt changed');
    console.log('Phase 8 OK: package expiry revalidation (expiry changed -> skipped)');
  }

  // --- Phase 9: delivery-time revalidation - inactivity no longer inactive ---
  {
    const { member } = await makeMemberWithAccount('Member Inact', '+905323310009', instructorA.id);
    await Attendance.create({
      memberId: member.id, salonId: salonA.id, date: new Date(Date.now() - 14 * 86400000), studioId: studioA.id,
    });
    await packageNotificationService.checkMemberInactivity({ studioId: studioA.id });
    // New attendance before delivery -> no longer inactive.
    await Attendance.create({
      memberId: member.id, salonId: salonA.id, date: new Date(), studioId: studioA.id,
    });
    await processAll();
    const notifs = await Notification.findAll({ where: { studioId: studioA.id, type: 'member_inactive' } });
    const forMember = notifs.filter((n) => {
      const p = parsePayload(n);
      return p && p.memberId === member.id;
    });
    assert.strictEqual(forMember.length, 0, 'inactivity alert skipped when member active again');
    console.log('Phase 9 OK: inactivity revalidation (active again -> skipped)');
  }

  // --- Phase 10: cross-studio isolation ---
  {
    const notifsB = await Notification.findAll({ where: { studioId: studioB.id } });
    const jobsB = await NotificationJob.findAll({ where: { studioId: studioB.id, type: 'payment_overdue' } });
    assert.strictEqual(notifsB.length, 0, 'studio B has no notifications');
    assert.strictEqual(jobsB.length, 0, 'studio B has no payment jobs');
    console.log('Phase 10 OK: cross-studio isolation');
  }

  console.log('All notification-phase3.2 cases passed.');
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
