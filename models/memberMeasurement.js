const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MemberMeasurement = sequelize.define('MemberMeasurement', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    measuredAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    height: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    weight: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    waist: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    hip: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    chest: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    arm: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    leg: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    shoulder: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    bodyFatPercentage: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
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
  }, {
    indexes: [
      { fields: ['memberId'] },
      { fields: ['measuredAt'] },
    ],
  });

  return MemberMeasurement;
};