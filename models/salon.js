const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Salon = sequelize.define('Salon', {
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
      type: DataTypes.ENUM('Yoga', 'Pilates'),
      allowNull: false,
    },
  });
  return Salon;
};