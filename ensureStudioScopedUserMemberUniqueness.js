const { sequelize } = require('./models');

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function tableExists(tableName) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getTableInfo(tableName) {
  const [rows] = await sequelize.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  return Array.isArray(rows) ? rows : [];
}

async function getTableSql(tableName) {
  const [rows] = await sequelize.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [tableName] }
  );
  return rows?.[0]?.sql || null;
}

async function getIndexMetadata(tableName) {
  const [indexList] = await sequelize.query(`PRAGMA index_list(${quoteIdentifier(tableName)})`);
  const list = Array.isArray(indexList) ? indexList : [];
  const output = [];
  for (const row of list) {
    const [indexInfo] = await sequelize.query(`PRAGMA index_info(${quoteIdentifier(row.name)})`);
    const [indexSqlRows] = await sequelize.query(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      { replacements: [row.name] }
    );
    output.push({
      ...row,
      columns: Array.isArray(indexInfo) ? indexInfo.map((col) => col.name) : [],
      sql: indexSqlRows?.[0]?.sql || null,
    });
  }
  return output;
}

async function getForeignKeys(tableName) {
  const [rows] = await sequelize.query(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
  return Array.isArray(rows) ? rows : [];
}

async function getSqliteSequence(tableName) {
  const [rows] = await sequelize.query('SELECT seq FROM sqlite_sequence WHERE name = ?', {
    replacements: [tableName],
  });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return Number(rows[0].seq);
}

async function setSqliteSequence(tableName, seq) {
  if (!Number.isFinite(seq)) return;
  await sequelize.query('DELETE FROM sqlite_sequence WHERE name = ?;', { replacements: [tableName] });
  await sequelize.query('INSERT INTO sqlite_sequence(name, seq) VALUES(?, ?);', {
    replacements: [tableName, seq],
  });
}

function hasInlineUniqueForColumn(tableSql, columnName) {
  if (typeof tableSql !== 'string' || tableSql.trim() === '') return false;
  const escapedColumn = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const columnLevel = new RegExp(`([\"\x60]?${escapedColumn}[\"\x60]?[^,)]*\\bUNIQUE\\b)`, 'i');
  const tableLevel = new RegExp(`\\bUNIQUE\\s*\\(([^)]*\\b${escapedColumn}\\b[^)]*)\\)`, 'i');
  return columnLevel.test(tableSql) || tableLevel.test(tableSql);
}

function hasAutoincrementOnColumn(tableSql, columnName) {
  if (typeof tableSql !== 'string' || tableSql.trim() === '') return false;
  const escapedColumn = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`([\"\x60]?${escapedColumn}[\"\x60]?\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT)`, 'i');
  return pattern.test(tableSql);
}

function buildColumnSql({ column, tableSql, nullableOverride = null, singlePrimaryKey = false }) {
  const parts = [quoteIdentifier(column.name)];

  if (column.type && String(column.type).trim() !== '') {
    parts.push(column.type);
  }

  const shouldMarkPrimary = singlePrimaryKey && Number(column.pk) === 1;
  if (shouldMarkPrimary) {
    parts.push('PRIMARY KEY');
    if (hasAutoincrementOnColumn(tableSql, column.name)) {
      parts.push('AUTOINCREMENT');
    }
  }

  const shouldBeNotNull = nullableOverride === true ? false : Number(column.notnull) === 1;
  if (!shouldMarkPrimary && shouldBeNotNull) {
    parts.push('NOT NULL');
  }

  if (column.dflt_value !== null && column.dflt_value !== undefined) {
    parts.push(`DEFAULT ${column.dflt_value}`);
  }

  return parts.join(' ');
}

function buildForeignKeyConstraints(foreignKeys) {
  if (!Array.isArray(foreignKeys) || foreignKeys.length === 0) return [];
  const grouped = new Map();
  for (const fk of foreignKeys) {
    if (!grouped.has(fk.id)) grouped.set(fk.id, []);
    grouped.get(fk.id).push(fk);
  }

  const constraints = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.seq - b.seq);
    const fromCols = rows.map((row) => quoteIdentifier(row.from)).join(', ');
    const toCols = rows.map((row) => quoteIdentifier(row.to)).join(', ');
    const referencedTable = quoteIdentifier(rows[0].table);
    let constraint = `FOREIGN KEY (${fromCols}) REFERENCES ${referencedTable} (${toCols})`;
    if (rows[0].on_update) constraint += ` ON UPDATE ${rows[0].on_update}`;
    if (rows[0].on_delete) constraint += ` ON DELETE ${rows[0].on_delete}`;
    if (rows[0].match && rows[0].match !== 'NONE') constraint += ` MATCH ${rows[0].match}`;
    constraints.push(constraint);
  }
  return constraints;
}

function singleColumnUniqueIndexExists(indexes, columnName) {
  return indexes.some((index) => index.unique === 1 && index.columns.length === 1 && index.columns[0] === columnName);
}

function namedCompositeUniqueExists(indexes, indexName, columns) {
  return indexes.some((index) => {
    if (index.name !== indexName) return false;
    if (index.unique !== 1) return false;
    if (index.columns.length !== columns.length) return false;
    return columns.every((columnName, i) => index.columns[i] === columnName);
  });
}

async function runConflictPreflight() {
  const [usersExact] = await sequelize.query(
    'SELECT studioId, username, COUNT(*) AS count FROM Users GROUP BY studioId, username HAVING COUNT(*) > 1 LIMIT 1;'
  );
  if (Array.isArray(usersExact) && usersExact.length > 0) {
    throw new Error('Users has same-studio duplicate usernames; aborting migration');
  }

  const [usersNormalized] = await sequelize.query(
    "SELECT studioId, LOWER(TRIM(username)) AS normalizedUsername, COUNT(*) AS count FROM Users GROUP BY studioId, LOWER(TRIM(username)) HAVING COUNT(*) > 1 LIMIT 1;"
  );
  if (Array.isArray(usersNormalized) && usersNormalized.length > 0) {
    throw new Error('Users has normalized username collisions; aborting migration');
  }

  const [membersExact] = await sequelize.query(
    'SELECT studioId, email, COUNT(*) AS count FROM Members WHERE email IS NOT NULL GROUP BY studioId, email HAVING COUNT(*) > 1 LIMIT 1;'
  );
  if (Array.isArray(membersExact) && membersExact.length > 0) {
    throw new Error('Members has same-studio duplicate non-null emails; aborting migration');
  }

  const [membersNormalized] = await sequelize.query(
    "SELECT studioId, LOWER(TRIM(email)) AS normalizedEmail, COUNT(*) AS count FROM Members WHERE email IS NOT NULL GROUP BY studioId, LOWER(TRIM(email)) HAVING COUNT(*) > 1 LIMIT 1;"
  );
  if (Array.isArray(membersNormalized) && membersNormalized.length > 0) {
    throw new Error('Members has normalized email collisions; aborting migration');
  }
}

async function verifyCountAndIdsPreserved(tableName, backupTableName, beforeCount) {
  const [afterCountRows] = await sequelize.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)};`);
  const afterCount = Number(afterCountRows?.[0]?.count || 0);
  if (afterCount !== beforeCount) {
    throw new Error(`${tableName} row count changed during rebuild`);
  }

  const [missingIds] = await sequelize.query(
    `SELECT id FROM ${quoteIdentifier(backupTableName)} EXCEPT SELECT id FROM ${quoteIdentifier(tableName)} LIMIT 1;`
  );
  if (Array.isArray(missingIds) && missingIds.length > 0) {
    throw new Error(`${tableName} lost IDs during rebuild`);
  }

  const [newIds] = await sequelize.query(
    `SELECT id FROM ${quoteIdentifier(tableName)} EXCEPT SELECT id FROM ${quoteIdentifier(backupTableName)} LIMIT 1;`
  );
  if (Array.isArray(newIds) && newIds.length > 0) {
    throw new Error(`${tableName} gained unexpected IDs during rebuild`);
  }
}

async function verifyValuesPreserved(tableName, backupTableName, comparableColumns) {
  if (!Array.isArray(comparableColumns) || comparableColumns.length === 0) return;

  const mismatchConditions = comparableColumns
    .map((col) => `COALESCE(CAST(curr.${quoteIdentifier(col)} AS TEXT), '__NULL__') <> COALESCE(CAST(prev.${quoteIdentifier(col)} AS TEXT), '__NULL__')`)
    .join(' OR ');

  const [mismatchRows] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(backupTableName)} prev JOIN ${quoteIdentifier(tableName)} curr ON curr.id = prev.id WHERE ${mismatchConditions};`
  );
  const mismatchCount = Number(mismatchRows?.[0]?.count || 0);
  if (mismatchCount > 0) {
    throw new Error(`${tableName} values changed during rebuild`);
  }
}

async function createNamedCompositeIndex(tableName, indexName, columns) {
  const quotedColumns = columns.map((columnName) => quoteIdentifier(columnName)).join(', ');
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)}(${quotedColumns});`
  );
}

async function rebuildTableIfNeeded(options) {
  const {
    tableName,
    targetColumn,
    targetColumnShouldBeNullable,
    compositeIndexName,
    compositeColumns,
  } = options;

  const tableSql = await getTableSql(tableName);
  const tableInfo = await getTableInfo(tableName);
  const indexes = await getIndexMetadata(tableName);
  const foreignKeys = await getForeignKeys(tableName);

  const targetColumnInfo = tableInfo.find((column) => column.name === targetColumn);
  if (!targetColumnInfo) {
    throw new Error(`${tableName}.${targetColumn} does not exist`);
  }

  const hasGlobalSingleUnique = singleColumnUniqueIndexExists(indexes, targetColumn) || hasInlineUniqueForColumn(tableSql, targetColumn);
  const compositeAlreadyExists = namedCompositeUniqueExists(indexes, compositeIndexName, compositeColumns);
  const needsNullableAdjustment = targetColumnShouldBeNullable && Number(targetColumnInfo.notnull) === 1;
  const needsRebuild = hasGlobalSingleUnique || needsNullableAdjustment;

  if (!needsRebuild) {
    if (!compositeAlreadyExists) {
      await createNamedCompositeIndex(tableName, compositeIndexName, compositeColumns);
      return { rebuilt: false, indexCreated: true, reason: 'composite-index-added' };
    }
    return { rebuilt: false, indexCreated: false, reason: 'already-compliant' };
  }

  const backupTableName = `__pre_${tableName.toLowerCase()}_phase38`;
  const replacementTableName = `__new_${tableName.toLowerCase()}_phase38`;

  const [beforeCountRows] = await sequelize.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)};`);
  const beforeCount = Number(beforeCountRows?.[0]?.count || 0);
  const beforeSequence = await getSqliteSequence(tableName);

  await sequelize.query(`DROP TABLE IF EXISTS ${quoteIdentifier(backupTableName)};`);
  await sequelize.query(`DROP TABLE IF EXISTS ${quoteIdentifier(replacementTableName)};`);
  await sequelize.query(`CREATE TABLE ${quoteIdentifier(backupTableName)} AS SELECT * FROM ${quoteIdentifier(tableName)};`);

  const primaryKeyColumns = tableInfo
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk));

  const singlePrimaryKey = primaryKeyColumns.length === 1;
  const columnDefinitions = tableInfo.map((column) => buildColumnSql({
    column,
    tableSql,
    nullableOverride: column.name === targetColumn ? targetColumnShouldBeNullable : null,
    singlePrimaryKey,
  }));

  const tableConstraints = [];
  if (!singlePrimaryKey && primaryKeyColumns.length > 0) {
    tableConstraints.push(`PRIMARY KEY (${primaryKeyColumns.map((column) => quoteIdentifier(column.name)).join(', ')})`);
  }
  tableConstraints.push(...buildForeignKeyConstraints(foreignKeys));

  const createSqlParts = [...columnDefinitions, ...tableConstraints];
  const createTableSql = `CREATE TABLE ${quoteIdentifier(replacementTableName)} (${createSqlParts.join(', ')});`;
  await sequelize.query(createTableSql);

  const insertColumns = tableInfo.map((column) => quoteIdentifier(column.name)).join(', ');
  await sequelize.query(
    `INSERT INTO ${quoteIdentifier(replacementTableName)} (${insertColumns}) SELECT ${insertColumns} FROM ${quoteIdentifier(tableName)};`
  );

  const [replacementCountRows] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(replacementTableName)};`
  );
  const replacementCount = Number(replacementCountRows?.[0]?.count || 0);
  if (replacementCount !== beforeCount) {
    throw new Error(`${tableName} replacement table row count mismatch; aborting swap`);
  }

  await sequelize.query(`DROP TABLE ${quoteIdentifier(tableName)};`);
  await sequelize.query(`ALTER TABLE ${quoteIdentifier(replacementTableName)} RENAME TO ${quoteIdentifier(tableName)};`);

  for (const index of indexes) {
    if (!index.sql) continue;
    if (index.origin === 'pk') continue;
    const isTargetSingleUnique = index.unique === 1 && index.columns.length === 1 && index.columns[0] === targetColumn;
    if (isTargetSingleUnique) continue;
    await sequelize.query(index.sql);
  }

  await createNamedCompositeIndex(tableName, compositeIndexName, compositeColumns);

  const [maxIdRows] = await sequelize.query(`SELECT COALESCE(MAX(id), 0) AS maxId FROM ${quoteIdentifier(tableName)};`);
  const maxId = Number(maxIdRows?.[0]?.maxId || 0);
  const targetSequence = Number.isFinite(beforeSequence) ? Math.max(beforeSequence, maxId) : maxId;
  await setSqliteSequence(tableName, targetSequence);

  const rebuiltInfo = await getTableInfo(tableName);
  const rebuiltComparableColumns = tableInfo
    .map((column) => column.name)
    .filter((columnName) => rebuiltInfo.some((column) => column.name === columnName));
  await verifyCountAndIdsPreserved(tableName, backupTableName, beforeCount);
  await verifyValuesPreserved(tableName, backupTableName, rebuiltComparableColumns);

  await sequelize.query(`DROP TABLE IF EXISTS ${quoteIdentifier(backupTableName)};`);

  return {
    rebuilt: true,
    indexCreated: true,
    reason: hasGlobalSingleUnique && needsNullableAdjustment
      ? 'removed-global-unique-and-aligned-nullability'
      : (hasGlobalSingleUnique ? 'removed-global-unique' : 'aligned-nullability'),
  };
}

async function ensureStudioScopedUserMemberUniqueness() {
  const hasUsers = await tableExists('Users');
  const hasMembers = await tableExists('Members');
  if (!hasUsers || !hasMembers) {
    return {
      usersTableExists: hasUsers,
      membersTableExists: hasMembers,
      skipped: true,
      reason: 'required-table-missing',
    };
  }

  const usersColumns = await getTableInfo('Users');
  const membersColumns = await getTableInfo('Members');
  if (!usersColumns.some((column) => column.name === 'studioId')) {
    throw new Error('Users.studioId is required before enforcing studio-scoped username uniqueness');
  }
  if (!membersColumns.some((column) => column.name === 'studioId')) {
    throw new Error('Members.studioId is required before enforcing studio-scoped email uniqueness');
  }

  await runConflictPreflight();

  const fkStateRaw = await sequelize.query('PRAGMA foreign_keys;');
  const fkStateRows = Array.isArray(fkStateRaw)
    ? (Array.isArray(fkStateRaw[0]) ? fkStateRaw[0] : fkStateRaw)
    : [fkStateRaw];
  const previousForeignKeysState = Number(fkStateRows?.[0]?.foreign_keys || 0);

  let usersResult;
  let membersResult;
  try {
    await sequelize.query('PRAGMA foreign_keys = OFF;');
    await sequelize.query('BEGIN TRANSACTION;');

    usersResult = await rebuildTableIfNeeded({
      tableName: 'Users',
      targetColumn: 'username',
      targetColumnShouldBeNullable: false,
      compositeIndexName: 'users_studio_username_unique',
      compositeColumns: ['studioId', 'username'],
    });

    membersResult = await rebuildTableIfNeeded({
      tableName: 'Members',
      targetColumn: 'email',
      targetColumnShouldBeNullable: true,
      compositeIndexName: 'members_studio_email_unique',
      compositeColumns: ['studioId', 'email'],
    });

    await sequelize.query('COMMIT;');
  } catch (error) {
    await sequelize.query('ROLLBACK;');
    throw error;
  } finally {
    await sequelize.query(`PRAGMA foreign_keys = ${previousForeignKeysState ? 'ON' : 'OFF'};`);
  }

  const [fkViolations] = await sequelize.query('PRAGMA foreign_key_check;');
  if (Array.isArray(fkViolations) && fkViolations.length > 0) {
    throw new Error('foreign_key_check failed after studio-scoped uniqueness migration');
  }

  const [referenceChecks] = await sequelize.query(
    "SELECT m.name AS tableName, fk.[table] AS referencedTable, fk.[from] AS fromColumn, fk.[to] AS toColumn FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk WHERE m.type='table' AND fk.[table] IN ('Users','Members') ORDER BY m.name, fk.id, fk.seq;"
  );

  for (const ref of Array.isArray(referenceChecks) ? referenceChecks : []) {
    const [orphanRows] = await sequelize.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(ref.tableName)} child LEFT JOIN ${quoteIdentifier(ref.referencedTable)} parent ON child.${quoteIdentifier(ref.fromColumn)} = parent.${quoteIdentifier(ref.toColumn)} WHERE child.${quoteIdentifier(ref.fromColumn)} IS NOT NULL AND parent.${quoteIdentifier(ref.toColumn)} IS NULL;`
    );
    const orphanCount = Number(orphanRows?.[0]?.count || 0);
    if (orphanCount > 0) {
      throw new Error(`Orphan references detected in ${ref.tableName}.${ref.fromColumn} -> ${ref.referencedTable}.${ref.toColumn}`);
    }
  }

  const usersIndexes = await getIndexMetadata('Users');
  const membersIndexes = await getIndexMetadata('Members');
  if (!namedCompositeUniqueExists(usersIndexes, 'users_studio_username_unique', ['studioId', 'username'])) {
    throw new Error('users_studio_username_unique index was not created correctly');
  }
  if (!namedCompositeUniqueExists(membersIndexes, 'members_studio_email_unique', ['studioId', 'email'])) {
    throw new Error('members_studio_email_unique index was not created correctly');
  }

  const usersTableSql = await getTableSql('Users');
  const membersTableSql = await getTableSql('Members');

  return {
    usersTableExists: true,
    membersTableExists: true,
    usersResult,
    membersResult,
    usersStillHasInlineUniqueUsername: hasInlineUniqueForColumn(usersTableSql, 'username'),
    membersStillHasInlineUniqueEmail: hasInlineUniqueForColumn(membersTableSql, 'email'),
  };
}

module.exports = ensureStudioScopedUserMemberUniqueness;