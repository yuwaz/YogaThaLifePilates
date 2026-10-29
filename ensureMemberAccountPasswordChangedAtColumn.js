const { sequelize } = require('./models');

async function ensureMemberAccountPasswordChangedAtColumn() {
  const [results] = await sequelize.query("PRAGMA table_info('MemberAccounts')");

  // On a fresh database the table may not exist yet; sequelize.sync() will create it.
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const hasColumn = results.some((col) => col.name === 'passwordChangedAt');

  if (!hasColumn) {
    await sequelize.query("ALTER TABLE MemberAccounts ADD COLUMN passwordChangedAt DATETIME NULL;");
    console.log('[DB MIGRATION] Added passwordChangedAt column to MemberAccounts');
  }
}

module.exports = ensureMemberAccountPasswordChangedAtColumn;
