const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { sequelize } = require('./models');

const authRoutes = require('./routes/auth');
const memberAuthRoutes = require('./routes/memberAuth');
const memberSelfRoutes = require('./routes/memberSelf');
const memberNotificationsRoutes = require('./routes/memberNotifications');
const registerRoutes = require('./routes/register');
const usersRoutes = require('./routes/settings/users');
const salonsRoutes = require('./routes/settings/salons');
const equipmentRoutes = require('./routes/settings/equipment');
const lessonPackagesRoutes = require('./routes/settings/lessonPackages');
const memberTypesRoutes = require('./routes/settings/memberTypes');
const paymentMethodsRoutes = require('./routes/settings/paymentMethods');
const membersRoutes = require('./routes/settings/members');
const reservationsRoutes = require('./routes/settings/reservations');
const paymentsRoutes = require('./routes/settings/payments');
const attendancesRoutes = require('./routes/settings/attendances');
const reportsRoutes = require('./routes/settings/reports');
const notificationsSettingsRoutes = require('./routes/settings/notifications');
const expensesRoutes = require('./routes/settings/expenses');
const manualCardUsagesRoutes = require('./routes/settings/manual-card-usages');
const studioOnboardingRoutes = require('./routes/settings/studio-onboarding');
const subscriptionRoutes = require('./routes/subscription');
const subscriptionSettingsRoutes = require('./routes/settings/subscription');
const backofficeAuthRoutes = require('./routes/backoffice/auth');
const backofficeOpsRoutes = require('./routes/backoffice/ops');
const backofficeStudiosRoutes = require('./routes/backoffice/studios');

const app = express();
// Apply CORS globally before all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Keep special CORS preflight for /auth/login
app.options('/auth/login', cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Auth routes (CORS also handled in router)
app.use('/auth', authRoutes);
app.use('/member-auth', memberAuthRoutes);
app.use('/member', memberSelfRoutes);
app.use('/member/notifications', memberNotificationsRoutes);
app.use('/register', registerRoutes);
app.use('/settings/users', usersRoutes);
app.use('/settings/salons', salonsRoutes);
app.use('/settings/equipment', equipmentRoutes);
app.use('/settings/lessonPackages', lessonPackagesRoutes);
app.use('/settings/members', membersRoutes);
app.use('/settings/reservations', reservationsRoutes);
app.use('/settings/payments', paymentsRoutes);
app.use('/settings/attendances', attendancesRoutes);
app.use('/settings/expenses', expensesRoutes);
app.use('/settings/manual-card-usages', manualCardUsagesRoutes);
app.use('/settings/studio/onboarding', studioOnboardingRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/settings/subscription', subscriptionSettingsRoutes);

app.use('/settings/memberTypes', memberTypesRoutes);
app.use('/settings/paymentMethods', paymentMethodsRoutes);
app.use('/settings/reports', reportsRoutes);
app.use('/settings/notifications', notificationsSettingsRoutes);

const backofficeEnabled = ['1', 'true'].includes(
  String(process.env.BACKOFFICE_ENABLED || '').trim().toLowerCase()
);

if (backofficeEnabled) {
  app.use('/backoffice/auth', backofficeAuthRoutes);
  app.use('/backoffice/ops', backofficeOpsRoutes);
  app.use('/backoffice/studios', backofficeStudiosRoutes);
}

// Health check
app.get('/', (req, res) => res.send('Fitness Studio API running'));

// Fallback 404 handler for unmatched routes (returns JSON, not HTML)
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not found' });
});

// Start server

const ensureMemberSoftDeleteColumns = require('./ensureMemberSoftDeleteColumns');
const ensureAttendanceReservationColumn = require('./ensureAttendanceReservationColumn');
const ensureAttendanceInstructorColumn = require('./ensureAttendanceInstructorColumn');
const ensureMemberMeasurementsTable = require('./ensureMemberMeasurementsTable');
const ensureInstructorPayoutAndSessionTypeColumns = require('./ensureInstructorPayoutAndSessionTypeColumns');
const ensureManualCardUsagesTable = require('./ensureManualCardUsagesTable');
const ensureStudiosTable = require('./ensureStudiosTable');
const ensureStudioCodeColumn = require('./ensureStudioCodeColumn');
const ensureStudioOnboardingColumns = require('./ensureStudioOnboardingColumns');
const ensureUserStudioIdColumn = require('./ensureUserStudioIdColumn');
const ensureMemberStudioIdColumn = require('./ensureMemberStudioIdColumn');
const ensureSalonStudioIdColumn = require('./ensureSalonStudioIdColumn');
const ensureMemberTypeStudioIdColumn = require('./ensureMemberTypeStudioIdColumn');
const ensureLessonPackageStudioIdColumn = require('./ensureLessonPackageStudioIdColumn');
const ensurePaymentMethodStudioIdColumn = require('./ensurePaymentMethodStudioIdColumn');
const ensureEquipmentStudioIdColumn = require('./ensureEquipmentStudioIdColumn');
const ensureExpenseStudioIdColumn = require('./ensureExpenseStudioIdColumn');
const ensurePaymentStudioIdColumn = require('./ensurePaymentStudioIdColumn');
const ensureReservationStudioIdColumn = require('./ensureReservationStudioIdColumn');
const ensureAttendanceStudioIdColumn = require('./ensureAttendanceStudioIdColumn');
const ensureMemberLessonPackageStudioIdColumn = require('./ensureMemberLessonPackageStudioIdColumn');
const ensureMemberMeasurementStudioIdColumn = require('./ensureMemberMeasurementStudioIdColumn');
const ensureStudioScopedUserMemberUniqueness = require('./ensureStudioScopedUserMemberUniqueness');
const ensureStudioSubscriptionEntitlementsTable = require('./ensureStudioSubscriptionEntitlementsTable');
const ensureSubscriptionPurchaseIntentsTable = require('./ensureSubscriptionPurchaseIntentsTable');
const ensureAppleSubscriptionTransactionsTable = require('./ensureAppleSubscriptionTransactionsTable');
const ensureAppleServerNotificationInboxTable = require('./ensureAppleServerNotificationInboxTable');
const ensureGooglePlaySubscriptionTransactionsTable = require('./ensureGooglePlaySubscriptionTransactionsTable');
const ensureGooglePubSubNotificationInboxTable = require('./ensureGooglePubSubNotificationInboxTable');
const ensurePlatformAdminsTable = require('./ensurePlatformAdminsTable');
const ensurePlatformAuditLogsTable = require('./ensurePlatformAuditLogsTable');
const ensureStudioManualSubscriptionOverridesTable = require('./ensureStudioManualSubscriptionOverridesTable');
const ensureMemberAccountsTable = require('./ensureMemberAccountsTable');
const ensureMemberAccountPasswordChangedAtColumn = require('./ensureMemberAccountPasswordChangedAtColumn');
const ensureMemberAccountTokenVersionColumn = require('./ensureMemberAccountTokenVersionColumn');
const ensureMemberAccountMembershipsTable = require('./ensureMemberAccountMembershipsTable');
const ensureMemberActivationCodesTable = require('./ensureMemberActivationCodesTable');
const ensureMemberActivationCodePurposeColumn = require('./ensureMemberActivationCodePurposeColumn');
const ensureMemberNormalizedPhoneColumn = require('./ensureMemberNormalizedPhoneColumn');
const ensureUserFeeHistoryTable = require('./ensureUserFeeHistoryTable');
const ensureNotificationTables = require('./ensureNotificationTables');
const ensureDeviceTokensTable = require('./ensureDeviceTokensTable');
const ensureNotificationPushDeliveriesTable = require('./ensureNotificationPushDeliveriesTable');
const { createNotificationScheduler, isWorkerEnabled, isPushWorkerEnabled } = require('./services/notificationScheduler');
const ensureMemberLessonPackageExpiryAndDueDate = require('./ensureMemberLessonPackageExpiryAndDueDate');
const PORT = process.env.PORT || 3000;
(async () => {
  await ensureStudiosTable();
  await ensurePlatformAdminsTable();
  await ensurePlatformAuditLogsTable();
  await ensureStudioManualSubscriptionOverridesTable();
  await ensureMemberAccountsTable();
  await ensureMemberAccountPasswordChangedAtColumn();
  await ensureMemberAccountTokenVersionColumn();
  await ensureMemberAccountMembershipsTable();
  await ensureMemberActivationCodesTable();
  await ensureMemberActivationCodePurposeColumn();
  await ensureStudioSubscriptionEntitlementsTable();
  await ensureSubscriptionPurchaseIntentsTable();
  await ensureAppleSubscriptionTransactionsTable();
  await ensureAppleServerNotificationInboxTable();
  await ensureGooglePlaySubscriptionTransactionsTable();
  await ensureGooglePubSubNotificationInboxTable();
  await ensureStudioCodeColumn();
  await ensureStudioOnboardingColumns();
  await ensureUserStudioIdColumn();
  await ensureMemberStudioIdColumn();
  await ensureSalonStudioIdColumn();
  await ensureMemberTypeStudioIdColumn();
  await ensureLessonPackageStudioIdColumn();
  await ensurePaymentMethodStudioIdColumn();
  await ensureEquipmentStudioIdColumn();
  await ensureExpenseStudioIdColumn();
  await ensurePaymentStudioIdColumn();
  await ensureReservationStudioIdColumn();
  await ensureAttendanceStudioIdColumn();
  await ensureMemberLessonPackageStudioIdColumn();
  await ensureMemberLessonPackageExpiryAndDueDate();
  await ensureManualCardUsagesTable();
  await ensureMemberMeasurementStudioIdColumn();
  await ensureMemberSoftDeleteColumns();
  await ensureAttendanceReservationColumn();
  await ensureAttendanceInstructorColumn();
  await ensureMemberMeasurementsTable();
  await ensureStudioScopedUserMemberUniqueness();
  await ensureInstructorPayoutAndSessionTypeColumns();
  await sequelize.sync();
  await ensureUserFeeHistoryTable();
  await ensureMemberNormalizedPhoneColumn();
  await ensureNotificationTables();
  await ensureDeviceTokensTable();
  await ensureNotificationPushDeliveriesTable();
  // Notification worker: DISABLED by default. Starts only with an explicit
  // NOTIFICATIONS_WORKER_ENABLED=1. Never started by importing modules.
  if (isWorkerEnabled()) {
    // Push processing requires BOTH NOTIFICATIONS_WORKER_ENABLED=1 AND
    // PUSH_WORKER_ENABLED=1, plus valid Firebase credentials. The transport is
    // created lazily (no Firebase init when push is off or credentials missing).
    let pushTransport = null;
    if (isPushWorkerEnabled()) {
      try {
        const { createFirebasePushTransport } = require('./services/firebasePushTransport');
        pushTransport = createFirebasePushTransport();
        console.log('[NotificationScheduler] push worker enabled via PUSH_WORKER_ENABLED=1');
      } catch (err) {
        console.error('[NotificationScheduler] push worker disabled:', err && err.message);
        pushTransport = null;
      }
    }
    const scheduler = createNotificationScheduler({ pushTransport });
    scheduler.start();
    console.log('[NotificationScheduler] worker enabled via NOTIFICATIONS_WORKER_ENABLED=1');
  }
  // Listen on all network interfaces for external access
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
})();

module.exports = app;
