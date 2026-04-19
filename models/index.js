const { Sequelize } = require('sequelize');
const User = require('./user');
const Salon = require('./salon');
const Equipment = require('./equipment');
const Member = require('./member');
const MemberType = require('./memberType');
const LessonPackage = require('./lessonPackage');
const Reservation = require('./reservation');
const Attendance = require('./attendance');
const Payment = require('./payment');
const PaymentMethod = require('./paymentMethod');
const MemberLessonPackage = require('./memberLessonPackage');

const sequelize = new Sequelize(process.env.DATABASE_URL || 'sqlite::memory:', {
  dialect: 'sqlite',
  storage: './database.sqlite',
  logging: false,
});

// Model initialization
const models = {
  User: User(sequelize),
  Salon: Salon(sequelize),
  Equipment: Equipment(sequelize),
  Member: Member(sequelize),
  MemberType: MemberType(sequelize),
  LessonPackage: LessonPackage(sequelize),
  Reservation: Reservation(sequelize),
  Attendance: Attendance(sequelize),
  Payment: Payment(sequelize),
  PaymentMethod: PaymentMethod(sequelize),
  MemberLessonPackage: MemberLessonPackage(sequelize),
};
// MemberLessonPackage associations
models.MemberLessonPackage.belongsTo(models.Member, { foreignKey: 'memberId' });
models.MemberLessonPackage.belongsTo(models.LessonPackage, { foreignKey: 'lessonPackageId' });
models.Member.hasMany(models.MemberLessonPackage, { foreignKey: 'memberId' });
models.LessonPackage.hasMany(models.MemberLessonPackage, { foreignKey: 'lessonPackageId' });

// Associations
models.Equipment.belongsTo(models.Salon, { foreignKey: 'salonId' });
models.Salon.hasMany(models.Equipment, { foreignKey: 'salonId' });

models.Member.belongsTo(models.MemberType, { foreignKey: 'memberTypeId' });
models.MemberType.hasMany(models.Member, { foreignKey: 'memberTypeId' });

models.Reservation.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Reservation.belongsTo(models.Equipment, { foreignKey: 'equipmentId' });
models.Reservation.belongsTo(models.Salon, { foreignKey: 'salonId' });

models.Attendance.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Attendance.belongsTo(models.Salon, { foreignKey: 'salonId' });

models.Payment.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Payment.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId' });

// User <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)
// Member <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)

module.exports = {
  sequelize,
  ...models,
};
