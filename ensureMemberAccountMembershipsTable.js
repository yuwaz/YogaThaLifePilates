const { sequelize } = require('./models');

async function ensureMemberAccountMembershipsTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS MemberAccountMemberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL REFERENCES MemberAccounts(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      studioId INTEGER NOT NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      memberId INTEGER NOT NULL REFERENCES Members(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_account_memberships_account_studio_unique
    ON MemberAccountMemberships(accountId, studioId);
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_account_memberships_account_member_unique
    ON MemberAccountMemberships(accountId, memberId);
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_account_memberships_studio_member_unique
    ON MemberAccountMemberships(studioId, memberId);
  `);
}

module.exports = ensureMemberAccountMembershipsTable;
