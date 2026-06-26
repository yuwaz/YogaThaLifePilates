const { sequelize } = require('./models');

async function ensureAttendanceInstructorColumn() {
  const [results] = await sequelize.query("PRAGMA table_info('Attendances')");

  // On a fresh database, Attendances may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasInstructorId = results.some((col) => col.name === 'instructorId');

  if (!hasInstructorId) {
    await sequelize.query("ALTER TABLE Attendances ADD COLUMN instructorId INTEGER NULL;");
    console.log('[DB MIGRATION] Added instructorId column to Attendances');
  }
}

module.exports = ensureAttendanceInstructorColumn;
