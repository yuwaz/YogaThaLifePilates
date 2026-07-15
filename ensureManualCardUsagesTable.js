const { sequelize } = require('./models');

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getTableColumns(tableName) {
  const [rows] = await sequelize.query(`PRAGMA table_info('${tableName}')`);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.name);
}

async function createIndexIfMissing(indexName, tableName, columnName) {
  try {
    await sequelize.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnName});`);
  } catch (err) {
    console.warn(`[DB MIGRATION] Optional index ${indexName} was not created: ${err.message}`);
  }
}

async function ensureManualCardUsagesTable() {
  const hasStudios = await tableExists('Studios');
  if (!hasStudios) {
    throw new Error('Studios table is required before ensuring ManualCardUsages');
  }

  const [studioRows] = await sequelize.query('SELECT id FROM Studios WHERE id = ? LIMIT 1', {
    replacements: [1],
  });

  if (!Array.isArray(studioRows) || studioRows.length === 0) {
    throw new Error('Studio id=1 must exist before ensuring ManualCardUsages');
  }

  const hasTable = await tableExists('ManualCardUsages');
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE ManualCardUsages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usageDate DATE NOT NULL,
        memberTypeId INTEGER NOT NULL,
        usageCount INTEGER NOT NULL,
        note TEXT NULL,
        studioId INTEGER NOT NULL DEFAULT 1,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB MIGRATION] Created ManualCardUsages table');
  } else {
    const columns = await getTableColumns('ManualCardUsages');
    if (!columns.includes('studioId')) {
      await sequelize.query('ALTER TABLE ManualCardUsages ADD COLUMN studioId INTEGER NOT NULL DEFAULT 1;');
      console.log('[DB MIGRATION] Added studioId column to ManualCardUsages');
    }
  }

  const [countRows] = await sequelize.query('SELECT COUNT(*) AS count FROM ManualCardUsages WHERE studioId IS NULL;');
  const backfilledCount = Number(countRows?.[0]?.count || 0);
  if (backfilledCount > 0) {
    await sequelize.query('UPDATE ManualCardUsages SET studioId = 1 WHERE studioId IS NULL;');
    console.log(`[DB MIGRATION] Backfilled ${backfilledCount} ManualCardUsages rows with studioId=1`);
  }

  await createIndexIfMissing('idx_manual_card_usages_usage_date', 'ManualCardUsages', 'usageDate');
  await createIndexIfMissing('idx_manual_card_usages_member_type_id', 'ManualCardUsages', 'memberTypeId');

  return {
    createdTable: !hasTable,
    backfilledCount,
  };
}

module.exports = ensureManualCardUsagesTable;
