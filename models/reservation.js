const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Reservation = sequelize.define('Reservation', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    equipmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    salonId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    time: {
      type: DataTypes.TIME,
      allowNull: false,
    },
    recurrenceGroupId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    recurrenceType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    recurrenceEndDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  });
  return Reservation;
};