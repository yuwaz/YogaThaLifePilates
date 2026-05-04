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
      allowNull: true, // email is optional
      unique: false, // allow multiple nulls
      validate: {
        isEmail: {
          msg: 'Invalid email format',
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