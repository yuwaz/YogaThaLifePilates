const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const LessonPackage = sequelize.define('LessonPackage', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    lessonCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
      },
    },
    price: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: false,
      validate: {
        min: 0,
      },
    },
  });
  return LessonPackage;
};