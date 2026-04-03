const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Equipment = sequelize.define('Equipment', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('Mat', 'Reformer'),
      allowNull: false,
    },
    salonId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  });
  return Equipment;
};