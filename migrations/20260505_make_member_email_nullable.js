// Migration: Make Members.email nullable in SQLite, preserving all data
const { Sequelize } = require('sequelize');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. Get current Members table info
    const tableInfo = await queryInterface.sequelize.query(
      "PRAGMA table_info('Members');",
      { type: Sequelize.QueryTypes.SELECT }
    );
    const emailCol = tableInfo.find(col => col.name === 'email');
    if (!emailCol || emailCol.notnull === 0) {
      // Already nullable, nothing to do
      return;
    }
    // 2. Create new table with email nullable
    await queryInterface.sequelize.transaction(async (t) => {
      // 2a. Rename old table
      await queryInterface.sequelize.query(
        'ALTER TABLE Members RENAME TO Members_backup_email_notnull;',
        { transaction: t }
      );
      // 2b. Create new table with correct schema
      await queryInterface.sequelize.query(`
        CREATE TABLE Members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(255) NOT NULL,
          email VARCHAR(255) NULL,
          memberTypeId INTEGER NOT NULL,
          totalDebt DECIMAL(10,2) DEFAULT 0,
          remainingLessons INTEGER DEFAULT 0,
          assignedSalonIds JSON NOT NULL DEFAULT '[]',
          createdAt DATETIME NOT NULL,
          updatedAt DATETIME NOT NULL,
          isActive BOOLEAN NOT NULL DEFAULT 1,
          deletedAt DATETIME,
          assignedInstructorId INTEGER
        );
      `, { transaction: t });
      // 2c. Copy data, converting empty email to NULL
      await queryInterface.sequelize.query(`
        INSERT INTO Members (
          id, name, phone, email, memberTypeId, totalDebt, remainingLessons, assignedSalonIds, createdAt, updatedAt, isActive, deletedAt, assignedInstructorId
        )
        SELECT
          id, name, phone,
          CASE WHEN email IS NULL OR TRIM(email) = '' THEN NULL ELSE email END,
          memberTypeId, totalDebt, remainingLessons, assignedSalonIds, createdAt, updatedAt, isActive, deletedAt, assignedInstructorId
        FROM Members_backup_email_notnull;
      `, { transaction: t });
      // 2d. Drop old table
      await queryInterface.sequelize.query('DROP TABLE Members_backup_email_notnull;', { transaction: t });
    });
  },
  down: async (queryInterface, Sequelize) => {
    // No automatic down migration (would lose data if email is null)
    // You can manually revert if needed
  }
};
