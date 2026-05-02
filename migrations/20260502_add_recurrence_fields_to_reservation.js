// Migration: Add recurrence fields to Reservation

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Reservations', 'recurrenceGroupId', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Reservations', 'recurrenceType', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Reservations', 'recurrenceEndDate', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Reservations', 'recurrenceGroupId');
    await queryInterface.removeColumn('Reservations', 'recurrenceType');
    await queryInterface.removeColumn('Reservations', 'recurrenceEndDate');
  },
};
