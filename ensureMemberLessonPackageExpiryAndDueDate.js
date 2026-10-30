const { sequelize } = require('./models');

async function ensureMemberLessonPackageExpiryAndDueDate() {
  const [results] = await sequelize.query("PRAGMA table_info('MemberLessonPackages')");

  // On a fresh database the table may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasExpiresAt = results.some((col) => col.name === 'expiresAt');
  const hasDueDate = results.some((col) => col.name === 'dueDate');

  if (!hasExpiresAt) {
    await sequelize.query("ALTER TABLE MemberLessonPackages ADD COLUMN expiresAt DATEONLY NULL;");
    console.log('[DB MIGRATION] Added expiresAt column to MemberLessonPackages');
  }
  if (!hasDueDate) {
    await sequelize.query("ALTER TABLE MemberLessonPackages ADD COLUMN dueDate DATEONLY NULL;");
    console.log('[DB MIGRATION] Added dueDate column to MemberLessonPackages');
  }
}

module.exports = ensureMemberLessonPackageExpiryAndDueDate;
