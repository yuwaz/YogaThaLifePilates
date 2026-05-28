const { sequelize } = require('./models');

async function ensureMemberSoftDeleteColumns() {
  const [results] = await sequelize.query("PRAGMA table_info('Members')");
  const hasIsActive = results.some(col => col.name === 'isActive');
  const hasDeletedAt = results.some(col => col.name === 'deletedAt');
  const hasAssignedInstructorId = results.some(col => col.name === 'assignedInstructorId');
  const measurementColumns = [
    'height',
    'weight',
    'waist',
    'hip',
    'chest',
    'arm',
    'leg',
    'shoulder',
    'bodyFatPercentage',
  ];
  if (!hasIsActive) {
    await sequelize.query("ALTER TABLE Members ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1;");
    console.log('[DB MIGRATION] Added isActive column to Members');
  }
  if (!hasDeletedAt) {
    await sequelize.query("ALTER TABLE Members ADD COLUMN deletedAt DATETIME NULL;");
    console.log('[DB MIGRATION] Added deletedAt column to Members');
  }
  if (!hasAssignedInstructorId) {
    await sequelize.query("ALTER TABLE Members ADD COLUMN assignedInstructorId INTEGER NULL;");
    console.log('[DB MIGRATION] Added assignedInstructorId column to Members');
  }
  for (const column of measurementColumns) {
    const hasColumn = results.some(col => col.name === column);
    if (!hasColumn) {
      await sequelize.query(`ALTER TABLE Members ADD COLUMN ${column} DECIMAL(10,2) NULL;`);
      console.log(`[DB MIGRATION] Added ${column} column to Members`);
    }
  }
}

module.exports = ensureMemberSoftDeleteColumns;
