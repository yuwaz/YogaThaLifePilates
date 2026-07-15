const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ManualCardUsage = sequelize.define('ManualCardUsage', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    usageDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    memberTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    usageCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
      },
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    studioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      references: {
        model: 'Studios',
        key: 'id',
      },
    },
  });

  return ManualCardUsage;
};
