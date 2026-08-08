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
const StudioSubscriptionEntitlement = require('./studioSubscriptionEntitlement');
const SubscriptionPurchaseIntent = require('./subscriptionPurchaseIntent');
const AppleSubscriptionTransaction = require('./appleSubscriptionTransaction');
const AppleServerNotificationInbox = require('./appleServerNotificationInbox');
const GooglePlaySubscriptionTransaction = require('./googlePlaySubscriptionTransaction');
const GooglePubSubNotificationInbox = require('./googlePubSubNotificationInbox');
const PlatformAdmin = require('./platformAdmin');
const PlatformAuditLog = require('./platformAuditLog');
const StudioManualSubscriptionOverride = require('./studioManualSubscriptionOverride');

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
  StudioSubscriptionEntitlement: StudioSubscriptionEntitlement(sequelize),
  SubscriptionPurchaseIntent: SubscriptionPurchaseIntent(sequelize),
  AppleSubscriptionTransaction: AppleSubscriptionTransaction(sequelize),
  AppleServerNotificationInbox: AppleServerNotificationInbox(sequelize),
  GooglePlaySubscriptionTransaction: GooglePlaySubscriptionTransaction(sequelize),
  GooglePubSubNotificationInbox: GooglePubSubNotificationInbox(sequelize),
  PlatformAdmin: PlatformAdmin(sequelize),
  PlatformAuditLog: PlatformAuditLog(sequelize),
  StudioManualSubscriptionOverride: StudioManualSubscriptionOverride(sequelize),
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
models.Studio.hasMany(models.Equipment, { foreignKey: 'studioId' });
models.Equipment.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Expense, { foreignKey: 'studioId' });
models.Expense.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Payment, { foreignKey: 'studioId' });
models.Payment.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Reservation, { foreignKey: 'studioId' });
models.Reservation.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.Attendance, { foreignKey: 'studioId' });
models.Attendance.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.MemberLessonPackage, { foreignKey: 'studioId' });
models.MemberLessonPackage.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.ManualCardUsage, { foreignKey: 'studioId' });
models.ManualCardUsage.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.MemberMeasurement, { foreignKey: 'studioId' });
models.MemberMeasurement.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.StudioSubscriptionEntitlement, { foreignKey: 'studioId' });
models.StudioSubscriptionEntitlement.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.SubscriptionPurchaseIntent, { foreignKey: 'studioId' });
models.SubscriptionPurchaseIntent.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.User.hasMany(models.SubscriptionPurchaseIntent, {
  as: 'CreatedSubscriptionPurchaseIntents',
  foreignKey: 'createdByUserId',
  constraints: false,
});
models.SubscriptionPurchaseIntent.belongsTo(models.User, {
  as: 'CreatedByUser',
  foreignKey: 'createdByUserId',
  constraints: false,
});
models.Studio.hasMany(models.AppleSubscriptionTransaction, { foreignKey: 'studioId' });
models.AppleSubscriptionTransaction.belongsTo(models.Studio, { foreignKey: 'studioId' });
models.Studio.hasMany(models.GooglePlaySubscriptionTransaction, { foreignKey: 'studioId' });
models.GooglePlaySubscriptionTransaction.belongsTo(models.Studio, { foreignKey: 'studioId' });

models.Payment.belongsTo(models.Member, { foreignKey: 'memberId' });
models.Payment.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId' });

models.Expense.belongsTo(models.Salon, { foreignKey: 'salonId' });
models.Salon.hasMany(models.Expense, { foreignKey: 'salonId' });

models.Expense.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId' });
models.PaymentMethod.hasMany(models.Expense, { foreignKey: 'paymentMethodId' });

models.PlatformAdmin.hasMany(models.PlatformAuditLog, {
  foreignKey: 'actorPlatformAdminId',
});
models.PlatformAuditLog.belongsTo(models.PlatformAdmin, {
  foreignKey: 'actorPlatformAdminId',
});

models.Studio.hasMany(models.StudioManualSubscriptionOverride, {
  foreignKey: 'studioId',
});
models.StudioManualSubscriptionOverride.belongsTo(models.Studio, {
  foreignKey: 'studioId',
});
models.PlatformAdmin.hasMany(models.StudioManualSubscriptionOverride, {
  as: 'CreatedStudioManualSubscriptionOverrides',
  foreignKey: 'createdByPlatformAdminId',
});
models.StudioManualSubscriptionOverride.belongsTo(models.PlatformAdmin, {
  as: 'CreatedByPlatformAdmin',
  foreignKey: 'createdByPlatformAdminId',
});
models.PlatformAdmin.hasMany(models.StudioManualSubscriptionOverride, {
  as: 'RevokedStudioManualSubscriptionOverrides',
  foreignKey: 'revokedByPlatformAdminId',
});
models.StudioManualSubscriptionOverride.belongsTo(models.PlatformAdmin, {
  as: 'RevokedByPlatformAdmin',
  foreignKey: 'revokedByPlatformAdminId',
});

// User <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)
// Member <-> Salon: assignedSalonIds is an array of salon IDs (custom logic in app)

module.exports = {
  sequelize,
  ...models,
};
