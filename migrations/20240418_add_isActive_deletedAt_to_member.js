// Migration: Add isActive and deletedAt to Member

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Members', 'isActive', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn('Members', 'deletedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Members', 'isActive');
    await queryInterface.removeColumn('Members', 'deletedAt');
  },
};
