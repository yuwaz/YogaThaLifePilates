// Migration: Fix Members_old foreign keys for Reservations, Attendances, Payments, MemberLessonPackages
// Safely rebuilds tables to reference Members(id) instead of Members_old(id), preserving all data

const { Sequelize } = require('sequelize');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. PRAGMA foreign_keys=off
    await queryInterface.sequelize.query('PRAGMA foreign_keys=off;');

    // Helper to migrate a table
    async function migrateTable({ tableName, createSQL, columns }) {
      // Rename old table
      await queryInterface.sequelize.query(`ALTER TABLE ${tableName} RENAME TO ${tableName}_backup;`);
      // Create new table with correct foreign key
      await queryInterface.sequelize.query(createSQL);
      // Copy all data
      await queryInterface.sequelize.query(`INSERT INTO ${tableName} (${columns}) SELECT ${columns} FROM ${tableName}_backup;`);
      // Row count check
      const [[{ count: newCount }]] = await queryInterface.sequelize.query(`SELECT COUNT(*) as count FROM ${tableName};`);
      const [[{ count: backupCount }]] = await queryInterface.sequelize.query(`SELECT COUNT(*) as count FROM ${tableName}_backup;`);
      if (newCount !== backupCount) throw new Error(`${tableName} row count mismatch after migration!`);
      // Drop backup
      await queryInterface.sequelize.query(`DROP TABLE ${tableName}_backup;`);
    }

    // Reservations
    await migrateTable({
      tableName: 'Reservations',
      createSQL: `CREATE TABLE Reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memberId INTEGER NOT NULL REFERENCES Members(id),
        equipmentId INTEGER NOT NULL,
        salonId INTEGER NOT NULL,
        date DATE NOT NULL,
        time TIME NOT NULL,
        recurrenceGroupId VARCHAR(255),
        recurrenceType VARCHAR(255),
        recurrenceEndDate DATE
      );`,
      columns: 'id, memberId, equipmentId, salonId, date, time, recurrenceGroupId, recurrenceType, recurrenceEndDate'
    });

    // Attendances
    await migrateTable({
      tableName: 'Attendances',
      createSQL: `CREATE TABLE Attendances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memberId INTEGER NOT NULL REFERENCES Members(id),
        salonId INTEGER NOT NULL,
        date DATE NOT NULL
      );`,
      columns: 'id, memberId, salonId, date'
    });

    // Payments
    await migrateTable({
      tableName: 'Payments',
      createSQL: `CREATE TABLE Payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memberId INTEGER NOT NULL REFERENCES Members(id),
        amount DECIMAL(10,2) NOT NULL,
        paymentMethodId INTEGER NOT NULL,
        date DATE NOT NULL
      );`,
      columns: 'id, memberId, amount, paymentMethodId, date'
    });

    // MemberLessonPackages
    await migrateTable({
      tableName: 'MemberLessonPackages',
      createSQL: `CREATE TABLE MemberLessonPackages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memberId INTEGER NOT NULL REFERENCES Members(id),
        lessonPackageId INTEGER NOT NULL REFERENCES LessonPackages(id),
        assignedAt DATE NOT NULL DEFAULT (datetime('now')),
        originalPrice FLOAT NOT NULL,
        discountType VARCHAR(255),
        discountValue FLOAT,
        finalPrice FLOAT NOT NULL
      );`,
      columns: 'id, memberId, lessonPackageId, assignedAt, originalPrice, discountType, discountValue, finalPrice'
    });

    // 4. PRAGMA foreign_keys=on
    await queryInterface.sequelize.query('PRAGMA foreign_keys=on;');
  },
  down: async (queryInterface, Sequelize) => {
    // No automatic down migration (would require restoring backups)
  }
};
