const { sequelize } = require('./models');

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function createIndexIfMissing(indexName, tableName, columnName) {
  try {
    await sequelize.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnName});`);
  } catch (err) {
    console.warn(`[DB MIGRATION] Optional index ${indexName} was not created: ${err.message}`);
  }
}

async function ensureManualCardUsagesTable() {
  const hasTable = await tableExists('ManualCardUsages');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE ManualCardUsages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usageDate DATE NOT NULL,
        memberTypeId INTEGER NOT NULL,
        usageCount INTEGER NOT NULL,
        note TEXT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created ManualCardUsages table');
  }

  await createIndexIfMissing('idx_manual_card_usages_usage_date', 'ManualCardUsages', 'usageDate');
  await createIndexIfMissing('idx_manual_card_usages_member_type_id', 'ManualCardUsages', 'memberTypeId');
}

module.exports = ensureManualCardUsagesTable;
