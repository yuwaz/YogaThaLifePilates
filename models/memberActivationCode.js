const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('MemberActivationCode', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  studioId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'Studios',
      key: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  },
  memberId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'Members',
      key: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  },
  codeHash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  consumedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  createdByUserId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  },
  attemptCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  lastAttemptAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  indexes: [
    {
      name: 'member_activation_codes_one_unconsumed_per_member_unique',
      unique: true,
      fields: ['studioId', 'memberId'],
      where: {
        consumedAt: null,
      },
    },
    {
      name: 'member_activation_codes_member_idx',
      fields: ['memberId'],
    },
  ],
});
