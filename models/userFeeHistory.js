const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserFeeHistory = sequelize.define('UserFeeHistory', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    studioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Studios',
        key: 'id',
      },
    },
    groupSessionFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    individualSessionFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    effectiveFromDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  }, {
    updatedAt: false,
    indexes: [
      {
        name: 'user_fee_histories_studio_user_effective_unique',
        unique: true,
        fields: ['studioId', 'userId', 'effectiveFromDate'],
      },
    ],
  });
  return UserFeeHistory;
};
