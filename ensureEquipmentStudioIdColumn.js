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

async function ensureEquipmentStudioIdColumn() {
  const hasEquipment = await tableExists('Equipment');
  if (!hasEquipment) {
    return { addedColumn: false, backfilledCount: 0, equipmentTableExists: false };
  }

  const hasStudios = await tableExists('Studios');
  if (!hasStudios) {
    throw new Error('Studios table is required before ensuring Equipment.studioId');
  }

  const [studioRows] = await sequelize.query('SELECT id FROM Studios WHERE id = ? LIMIT 1', {
    replacements: [1],
  });

  if (!Array.isArray(studioRows) || studioRows.length === 0) {
    throw new Error('Studio id=1 must exist before ensuring Equipment.studioId');
  }

  const columns = await getTableColumns('Equipment');
  let addedColumn = false;
  if (!columns.includes('studioId')) {
    await sequelize.query('ALTER TABLE Equipment ADD COLUMN studioId INTEGER NOT NULL DEFAULT 1;');
    console.log('[DB MIGRATION] Added studioId column to Equipment');
    addedColumn = true;
  }

  const [countRows] = await sequelize.query('SELECT COUNT(*) AS count FROM Equipment WHERE studioId IS NULL;');
  const backfilledCount = Number(countRows?.[0]?.count || 0);

  if (backfilledCount > 0) {
    await sequelize.query('UPDATE Equipment SET studioId = 1 WHERE studioId IS NULL;');
    console.log(`[DB MIGRATION] Backfilled ${backfilledCount} Equipment rows with studioId=1`);
  }

  return { addedColumn, backfilledCount, equipmentTableExists: true };
}

module.exports = ensureEquipmentStudioIdColumn;