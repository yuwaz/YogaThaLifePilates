const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('MemberAccount', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  normalizedPhone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('active', 'disabled'),
    allowNull: false,
    defaultValue: 'active',
  },
  activatedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lastLoginAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  indexes: [
    {
      name: 'member_accounts_normalized_phone_unique',
      unique: true,
      fields: ['normalizedPhone'],
    },
  ],
});
