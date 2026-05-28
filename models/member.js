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
      unique: true, // allow multiple nulls, but unique for non-nulls
      defaultValue: null,
      validate: {
        isEmailOrNull(value) {
          if (value === null || value === undefined || value === '') return;
          const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
          if (!ok) throw new Error('Invalid email format');
        },
      },
      set(value) {
        if (typeof value === 'string' && value.trim() === '') {
          this.setDataValue('email', null);
        } else {
          this.setDataValue('email', value);
        }
      }
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
    height: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    weight: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    waist: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    hip: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    chest: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    arm: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    leg: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    shoulder: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
    },
    bodyFatPercentage: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: null,
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