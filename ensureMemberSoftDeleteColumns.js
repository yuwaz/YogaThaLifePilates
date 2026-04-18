const { sequelize } = require('./models');

async function ensureMemberSoftDeleteColumns() {
  const [results] = await sequelize.query("PRAGMA table_info('Members')");
  const hasIsActive = results.some(col => col.name === 'isActive');
  const hasDeletedAt = results.some(col => col.name === 'deletedAt');
  if (!hasIsActive) {
    await sequelize.query("ALTER TABLE Members ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1;");
    console.log('[DB MIGRATION] Added isActive column to Members');
  }
  if (!hasDeletedAt) {
    await sequelize.query("ALTER TABLE Members ADD COLUMN deletedAt DATETIME NULL;");
    console.log('[DB MIGRATION] Added deletedAt column to Members');
  }
}

module.exports = ensureMemberSoftDeleteColumns;
