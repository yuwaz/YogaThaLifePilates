// Migration: Add optional body measurements to Member

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const fields = [
      'height',
      'weight',
      'waist',
      'hip',
      'chest',
      'arm',
      'leg',
      'shoulder',
      'bodyFatPercentage',
    ];

    for (const field of fields) {
      await queryInterface.addColumn('Members', field, {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  down: async (queryInterface) => {
    const fields = [
      'bodyFatPercentage',
      'shoulder',
      'leg',
      'arm',
      'chest',
      'hip',
      'waist',
      'weight',
      'height',
    ];

    for (const field of fields) {
      await queryInterface.removeColumn('Members', field);
    }
  },
};