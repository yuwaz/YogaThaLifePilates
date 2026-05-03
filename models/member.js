const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Member = sequelize.define('Member', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        is: /^\+90[0-9]{10}$/,
      },
    },
      email: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
          isEmailOrNull(value) {
            if (value === null || value === undefined || value === '') return;
            if (typeof value === 'string' && value.length > 0) {
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
                throw new Error('Email is not valid');
              }
            }
          }
        },
      },
    memberTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    totalDebt: {
      type: DataTypes.DECIMAL(10,2),
      defaultValue: 0,
    },
    remainingLessons: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    assignedSalonIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    assignedInstructorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      // No FK constraint for minimal risk, but can be added later
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  });
  return Member;
};