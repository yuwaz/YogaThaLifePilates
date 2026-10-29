const { sequelize } = require('./models');

async function ensureMemberAccountTokenVersionColumn() {
  const [results] = await sequelize.query("PRAGMA table_info('MemberAccounts')");

  // On a fresh database the table may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasColumn = results.some((col) => col.name === 'tokenVersion');

  if (!hasColumn) {
    await sequelize.query("ALTER TABLE MemberAccounts ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0;");
    console.log('[DB MIGRATION] Added tokenVersion column to MemberAccounts');
  }

  await sequelize.query("UPDATE MemberAccounts SET tokenVersion = 0 WHERE tokenVersion IS NULL;");
}

module.exports = ensureMemberAccountTokenVersionColumn;
