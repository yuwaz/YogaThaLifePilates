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
  });
  return MemberType;
};