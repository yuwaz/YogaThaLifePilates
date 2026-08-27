const { sequelize } = require('./models');

async function ensureMemberActivationCodesTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS MemberActivationCodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      studioId INTEGER NOT NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      memberId INTEGER NOT NULL REFERENCES Members(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      codeHash VARCHAR(255) NOT NULL,
      expiresAt DATETIME NOT NULL,
      consumedAt DATETIME NULL,
      createdByUserId INTEGER NOT NULL REFERENCES Users(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      attemptCount INTEGER NOT NULL DEFAULT 0,
      lastAttemptAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_activation_codes_one_unconsumed_per_member_unique
    ON MemberActivationCodes(studioId, memberId)
    WHERE consumedAt IS NULL;
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS member_activation_codes_member_idx
    ON MemberActivationCodes(memberId);
  `);
}

module.exports = ensureMemberActivationCodesTable;
