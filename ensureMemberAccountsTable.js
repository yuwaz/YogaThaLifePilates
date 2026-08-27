const { sequelize } = require('./models');

async function ensureMemberAccountsTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS MemberAccounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalizedPhone VARCHAR(255) NOT NULL,
      passwordHash VARCHAR(255) NOT NULL,
      status VARCHAR(255) NOT NULL DEFAULT 'active',
      activatedAt DATETIME NULL,
      lastLoginAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_accounts_normalized_phone_unique
    ON MemberAccounts(normalizedPhone);
  `);
}

module.exports = ensureMemberAccountsTable;
