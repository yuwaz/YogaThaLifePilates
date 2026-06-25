const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Attendance = sequelize.define('Attendance', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    salonId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    date: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    reservationId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  });
  return Attendance;
};