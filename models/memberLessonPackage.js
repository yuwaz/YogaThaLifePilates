const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MemberLessonPackage = sequelize.define('MemberLessonPackage', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Members', key: 'id' },
    },
    lessonPackageId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'LessonPackages', key: 'id' },
    },
    assignedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    originalPrice: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    discountType: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isIn: [[null, 'amount', 'percent']]
      }
    },
    discountValue: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    finalPrice: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
  });
  return MemberLessonPackage;
};
