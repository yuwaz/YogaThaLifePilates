// Disposable validator (not part of product code): focused regression coverage
// for staff notification member identification — member_inactive, package low
// (threshold) and package exhausted (0 lessons) staff copies must contain the
// member's name, while the member's own copy keeps its original wording.
// Also verifies studio isolation (no cross-studio recipients). Runs against an
// isolated temp SQLite DB; never touches the real database.sqlite.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-staff-name-'));
process.env.DB_PATH = path.join(tmpRoot, 'validation.sqlite');

const {
  sequelize,
  Studio,
  User,
  Salon,
  MemberType,
  Member,
  MemberAccount,
  MemberAccountMembership,
  Attendance,
  Notification,
} = require('../models');
const {
  checkRemainingLessonsThreshold,
  checkMemberInactivity,
} = require('../services/packageNotificationService');
const { processDueJobs } = require('../services/notificationWorker');

async function notificationsFor(where) {
  return Notification.findAll({ where, order: [['id', 'ASC']] });
}

(async () => {
  await sequelize.sync({ force: true });

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'studio-a', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'studio-b', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const adminA = await User.create({ username: 'adminA', password: 'h', role: 'admin', studioId: studioA.id });
  const adminB = await User.create({ username: 'adminB', password: 'h', role: 'admin', studioId: studioB.id });
  const instructorA = await User.create({ username: 'instA', password: 'h', role: 'instructor', studioId: studioA.id });
  const salonA = await Salon.create({ name: 'Salon A', type: 'Yoga', studioId: studioA.id });
  const memberTypeA = await MemberType.create({ name: 'Group', color: '#AABBCC', studioId: studioA.id });

  let phoneSeq = 100;
  async function makeMember(name, { remainingLessons }) {
    const phone = `+90555000${String(phoneSeq++).padStart(4, '0')}`;
    const member = await Member.create({
      name, phone, normalizedPhone: phone, memberTypeId: memberTypeA.id, assignedSalonIds: [salonA.id],
      assignedInstructorId: instructorA.id, remainingLessons, isActive: true, studioId: studioA.id,
    });
    const account = await MemberAccount.create({ normalizedPhone: phone, passwordHash: 'x', status: 'active' });
    await MemberAccountMembership.create({ accountId: account.id, studioId: studioA.id, memberId: member.id });
    return { member, account };
  }

  // --- Case 1: package exhausted (0 remaining lessons) ---
  {
    const { member, account } = await makeMember('Ayşe Yılmaz', { remainingLessons: 0 });
    await checkRemainingLessonsThreshold(member.id, { studioId: studioA.id });
    await processDueJobs();

    const memberCopy = await notificationsFor({ recipientType: 'member', recipientId: account.id, type: 'package_low_lessons' });
    assert.strictEqual(memberCopy.length, 1, 'member receives one exhausted notification');
    assert.strictEqual(memberCopy[0].body, 'Üyenin ders paketinde ders kalmadı.', 'member copy wording unchanged');

    const staffCopies = await notificationsFor({ studioId: studioA.id, type: 'package_low_lessons', recipientType: ['instructor', 'admin'] });
    assert.strictEqual(staffCopies.length, 2, 'instructor + admin receive exhausted notification');
    for (const n of staffCopies) {
      assert.ok(n.body.includes('Ayşe Yılmaz'), `staff exhausted body identifies member: ${n.body}`);
      assert.strictEqual(n.body, 'Ayşe Yılmaz adlı üyenin ders paketinde ders kalmadı.');
      assert.strictEqual(n.payload.memberName, 'Ayşe Yılmaz', 'payload carries memberName');
    }
    console.log('S1 OK: package exhausted staff notifications identify the member');
  }

  // --- Case 2: package low (default threshold = 2) ---
  {
    const { member, account } = await makeMember('Mehmet Demir', { remainingLessons: 2 });
    await checkRemainingLessonsThreshold(member.id, { studioId: studioA.id });
    await processDueJobs();

    const memberCopy = await notificationsFor({ recipientType: 'member', recipientId: account.id, type: 'package_low_lessons' });
    assert.strictEqual(memberCopy.length, 1, 'member receives one low-lessons notification');
    assert.strictEqual(memberCopy[0].body, 'Üyenin ders paketinde 2 ders kaldı.', 'member copy wording unchanged');

    const staffCopies = await notificationsFor({ studioId: studioA.id, type: 'package_low_lessons', recipientType: ['instructor', 'admin'] });
    const forMember = staffCopies.filter((n) => Number(n.payload && n.payload.memberId) === Number(member.id));
    assert.strictEqual(forMember.length, 2, 'instructor + admin receive low-lessons notification');
    for (const n of forMember) {
      assert.strictEqual(n.body, 'Mehmet Demir adlı üyenin ders paketinde 2 ders kaldı.', `staff low body identifies member: ${n.body}`);
    }
    console.log('S2 OK: package low staff notifications identify the member');
  }

  // --- Case 3: member inactivity (exactly 14 days without attendance) ---
  {
    const { member, account } = await makeMember('Fatma Kaya', { remainingLessons: 10 });
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await Attendance.create({ memberId: member.id, studioId: studioA.id, salonId: salonA.id, date: fourteenDaysAgo });

    const { enqueued } = await checkMemberInactivity({ studioId: studioA.id });
    assert.strictEqual(enqueued, 1, 'one inactivity job enqueued');
    await processDueJobs();

    const staffCopies = await notificationsFor({ studioId: studioA.id, type: 'member_inactive' });
    assert.strictEqual(staffCopies.length, 2, 'instructor + admin receive inactivity notification');
    for (const n of staffCopies) {
      assert.ok(['instructor', 'admin'].includes(n.recipientType), 'inactivity never goes to the member');
      assert.strictEqual(n.body, 'Fatma Kaya adlı üye 14 gündür derse katılmadı.', `staff inactivity body identifies member: ${n.body}`);
      assert.strictEqual(n.payload.memberName, 'Fatma Kaya', 'payload carries memberName');
    }
    const memberCopies = await notificationsFor({ recipientType: 'member', recipientId: account.id, type: 'member_inactive' });
    assert.strictEqual(memberCopies.length, 0, 'member receives no inactivity notification');
    console.log('S3 OK: member_inactive staff notifications identify the member');
  }

  // --- Case 4: studio isolation (other studio admin receives nothing) ---
  {
    const crossStudio = await notificationsFor({ recipientType: 'admin', recipientId: adminB.id });
    assert.strictEqual(crossStudio.length, 0, 'studio B admin received nothing');
    const studioAAdmin = await notificationsFor({ recipientType: 'admin', recipientId: adminA.id });
    assert.ok(studioAAdmin.length >= 3, 'studio A admin received the staff notifications');
    console.log('S4 OK: studio isolation preserved');
  }

  console.log('All staff-notification member-name cases passed.');
  await sequelize.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  console.error('VALIDATION FAILED:', error);
  process.exit(1);
});
