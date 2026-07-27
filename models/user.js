const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('admin', 'instructor'),
      allowNull: false,
    },
    assignedSalonIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    permissions: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
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
    groupSessionFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
    },
    individualSessionFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
    },
  }, {
    indexes: [
      {
        name: 'users_studio_username_unique',
        unique: true,
        fields: ['studioId', 'username'],
      },
    ],
  });
  return User;
};