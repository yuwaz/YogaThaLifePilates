const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');
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
const Expense = require('./expense');
const MemberMeasurement = require('./memberMeasurement');
const ManualCardUsage = require('./manualCardUsage');
const Studio = require('./studio');

const preferredDbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve('/var/www/yogatha-backend/database.sqlite');
const fallbackDbPath = path.resolve(__dirname, '..', 'database.sqlite');
let dbPath = preferredDbPath;

try {
  fs.mkdirSync(path.dirname(preferredDbPath), { recursive: true });
} catch (err) {
  dbPath = fallbackDbPath;
}

console.log('USING DB:', dbPath);
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
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
  Expense: Expense(sequelize),
  MemberMeasurement: MemberMeasurement(sequelize),
  ManualCardUsage: ManualCardUsage(sequelize),
  Studio: Studio(sequelize),
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
models.ManualCardUsage.belongsTo(models.MemberType, { foreignKey: 'memberTypeId' });
models.MemberType.hasMany(models.ManualCardUsage, { foreignKey: 'memberTypeId' });
models.Member.hasMany(models.MemberMeasurement, { foreignKey: 'memberId' });
models.MemberMeasurement.belongsTo(models.Member, { foreignKey: 'memberId' });

models.Reservation.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Reservation.belongsTo(models.Equipment, { foreignKey: 'equipmentId' });
models.Reservation.belongsTo(models.Salon, { foreignKey: 'salonId' });

models.Attendance.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Attendance.belongsTo(models.Salon, { foreignKey: 'salonId' });
models.Attendance.belongsTo(models.Reservation, {
  foreignKey: 'reservationId',
  constraints: false,
});
models.Attendance.belongsTo(models.User, {
  as: 'Instructor',
  foreignKey: 'instructorId',
  constraints: false,
});

models.Studio.hasMany(models.User, { foreignKey: 'studioId' });
models.User.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Member, { foreignKey: 'studioId' });
models.Member.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Salon, { foreignKey: 'studioId' });
models.Salon.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.MemberType, { foreignKey: 'studioId' });
models.MemberType.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.LessonPackage, { foreignKey: 'studioId' });
models.LessonPackage.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.PaymentMethod, { foreignKey: 'studioId' });
models.PaymentMethod.belongsTo(models.Studio, { foreignKey: 'studioId' });

models.Payment.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Payment.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId' });

models.Expense.belongsTo(models.Salon, { foreignKey: 'salonId' });
models.Salon.hasMany(models.Expense, { foreignKey: 'salonId' });

models.Expense.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId' });
models.PaymentMethod.hasMany(models.Expense, { foreignKey: 'paymentMethodId' });

// User <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)
// Member <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)

module.exports = {
  sequelize,
  ...models,
};
