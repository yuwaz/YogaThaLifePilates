const { sequelize } = require('./models');
const { allocateBackfillStudioCode } = require('./services/studioCode');

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

async function getUniqueIndexesForTable(tableName) {
  const [indexes] = await sequelize.query(`PRAGMA index_list('${tableName}')`);
  if (!Array.isArray(indexes)) return [];

  const uniqueIndexes = [];
  for (const index of indexes) {
    if (!index.unique) continue;
    const [indexColumns] = await sequelize.query(`PRAGMA index_info('${index.name}')`);
    if (!Array.isArray(indexColumns)) continue;
    const columnNames = indexColumns.map((column) => column.name);
    uniqueIndexes.push({ name: index.name, columns: columnNames });
  }

  return uniqueIndexes;
}

async function uniqueIndexExistsForColumn(tableName, columnName) {
  const uniqueIndexes = await getUniqueIndexesForTable(tableName);
  return uniqueIndexes.some((index) => index.columns.length === 1 && index.columns[0] === columnName);
}

async function ensureStudioCodeColumn() {
  const hasStudios = await tableExists('Studios');
  if (!hasStudios) {
    return {
      studiosTableExists: false,
      addedStudioCodeColumn: false,
      backfilledCount: 0,
      seededStudioOneCode: false,
      uniqueIndexCreated: false,
    };
  }

  const columns = await getTableColumns('Studios');
  let addedStudioCodeColumn = false;
  if (!columns.includes('studioCode')) {
    await sequelize.query('ALTER TABLE Studios ADD COLUMN studioCode VARCHAR(40) NULL;');
    console.log('[DB MIGRATION] Added studioCode column to Studios');
    addedStudioCodeColumn = true;
  }

  const [studioRows] = await sequelize.query(
    'SELECT id, name, studioCode FROM Studios ORDER BY id ASC'
  );

  const rows = Array.isArray(studioRows) ? studioRows : [];
  const usedCodes = new Set();
  for (const row of rows) {
    if (typeof row.studioCode === 'string' && row.studioCode.trim() !== '') {
      usedCodes.add(row.studioCode.trim());
    }
  }

  let backfilledCount = 0;
  let seededStudioOneCode = false;
  for (const row of rows) {
    const hasCode = typeof row.studioCode === 'string' && row.studioCode.trim() !== '';
    if (hasCode) {
      continue;
    }

    const candidate = allocateBackfillStudioCode(row, usedCodes);
    if (!candidate) {
      throw new Error(`Unable to backfill studioCode for Studio id=${row.id}`);
    }

    await sequelize.query('UPDATE Studios SET studioCode = ? WHERE id = ?;', {
      replacements: [candidate, row.id],
    });
    usedCodes.add(candidate);
    backfilledCount += 1;
    if (row.id === 1) {
      seededStudioOneCode = candidate === 'yogatha';
    }
  }

  const uniqueIndexExists = await uniqueIndexExistsForColumn('Studios', 'studioCode');
  let uniqueIndexCreated = false;
  if (!uniqueIndexExists) {
    await sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS Studios_studioCode_unique ON Studios(studioCode);');
    uniqueIndexCreated = true;
    console.log('[DB MIGRATION] Ensured unique index on Studios.studioCode');
  }

  return {
    studiosTableExists: true,
    addedStudioCodeColumn,
    backfilledCount,
    seededStudioOneCode,
    uniqueIndexCreated,
  };
}

module.exports = ensureStudioCodeColumn;
