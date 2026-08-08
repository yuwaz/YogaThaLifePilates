const { DataTypes } = require('sequelize');

const PLATFORM_ADMIN_STATUSES = ['active', 'disabled'];

module.exports = (sequelize) => {
  const PlatformAdmin = sequelize.define('PlatformAdmin', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      set(value) {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
        this.setDataValue('email', normalized);
      },
      validate: {
        isEmail: true,
      },
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'active',
      validate: {
        isIn: [PLATFORM_ADMIN_STATUSES],
      },
    },
    mfaRequired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    indexes: [
      {
        name: 'platform_admins_email_unique',
        unique: true,
        fields: ['email'],
      },
    ],
  });

  return PlatformAdmin;
};