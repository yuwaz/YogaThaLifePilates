const { sequelize } = require('./models');

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureStudiosTable() {
  const hasTable = await tableExists('Studios');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE Studios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(255) NULL,
        country VARCHAR(2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        timezone VARCHAR(255) NOT NULL,
        subscriptionStatus VARCHAR(255) NOT NULL DEFAULT 'trial',
        trialEndsAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created Studios table');
  }

  const [existingStudios] = await sequelize.query(
    'SELECT id FROM Studios WHERE id = ? LIMIT 1',
    { replacements: [1] }
  );

  if (Array.isArray(existingStudios) && existingStudios.length > 0) {
    return;
  }

  await sequelize.query(
    `
      INSERT INTO Studios (
        id,
        name,
        email,
        phone,
        country,
        currency,
        timezone,
        subscriptionStatus,
        trialEndsAt,
        createdAt,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    {
      replacements: [
        1,
        'YogaTha Pilates',
        null,
        null,
        'TR',
        'TRY',
        'Europe/Istanbul',
        'active',
        null,
      ],
    }
  );

  console.log('[DB MIGRATION] Seeded Studio id=1');
}

module.exports = ensureStudiosTable;