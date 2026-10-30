const { sequelize } = require('./models');

async function ensureDeviceTokensTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS DeviceTokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerType VARCHAR(16) NOT NULL,
      ownerId INTEGER NOT NULL,
      studioId INTEGER NULL REFERENCES Studios(id) ON DELETE NO ACTION ON UPDATE CASCADE,
      token VARCHAR(255) NOT NULL,
      platform VARCHAR(16) NOT NULL,
      lastSeenAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      invalidatedAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_unique
    ON DeviceTokens(token);
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS device_tokens_owner_idx
    ON DeviceTokens(ownerType, ownerId);
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS device_tokens_studio_idx
    ON DeviceTokens(studioId);
  `);
}

module.exports = ensureDeviceTokensTable;
