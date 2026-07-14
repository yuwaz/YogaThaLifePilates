const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MemberType = sequelize.define('MemberType', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        is: /^#([A-Fa-f0-9]{6})$/,
      },
    },
    isCardBased: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    cardUsageFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
    },
    sessionType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'group',
      validate: {
        isIn: [['group', 'individual']],
      },
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
  return MemberType;
};