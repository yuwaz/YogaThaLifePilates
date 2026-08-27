const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('MemberAccountMembership', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  accountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'MemberAccounts',
      key: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
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
}, {
  indexes: [
    {
      name: 'member_account_memberships_account_studio_unique',
      unique: true,
      fields: ['accountId', 'studioId'],
    },
    {
      name: 'member_account_memberships_account_member_unique',
      unique: true,
      fields: ['accountId', 'memberId'],
    },
    {
      name: 'member_account_memberships_studio_member_unique',
      unique: true,
      fields: ['studioId', 'memberId'],
    },
  ],
});
