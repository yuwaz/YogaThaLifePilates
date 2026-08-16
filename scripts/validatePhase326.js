const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase326-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    Member,
    Reservation,
    Payment,
    StudioSubscriptionEntitlement,
    SubscriptionPurchaseIntent,
    AppleSubscriptionTransaction,
    GooglePlaySubscriptionTransaction,
  } = require('../models');

  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureGooglePlaySubscriptionTransactionsTable = require('../ensureGooglePlaySubscriptionTransactionsTable');
  const ensureGooglePubSubNotificationInboxTable = require('../ensureGooglePubSubNotificationInboxTable');
  const { buildAuthPayload, signAuthToken } = require('../utils/authToken');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC: process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC,
    APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO: process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO,
    APPLE_IAP_ENVIRONMENTS_ALLOWED: process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED,
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID,
    GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(BASE_ENV)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function configureCatalogEnv() {
    process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC = 'com.yogatha.sub.basic.monthly';
    process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO = 'com.yogatha.sub.pro.monthly';
    process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED = 'sandbox,production';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.yogatha.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID = 'basic_offer';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID = 'pro_offer';
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'phase326-secret-phase326-secret-123456';
  }

  async function test(name, fn) {
    try {
      await fn();
      report.testsPassed.push(name);
    } catch (error) {
      report.testsFailed.push({
        name,
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : 'Unknown error',
      });
    } finally {
      restoreEnv();
    }
  }

  function addDays(baseDate, days) {
    return new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
  }

  function makeToken(userLike) {
    return signAuthToken(buildAuthPayload(userLike));
  }

  function makeFallbackToken(userLike) {
    return jwt.sign({
      id: userLike.id,
      role: userLike.role,
      assignedSalonIds: Array.isArray(userLike.assignedSalonIds) ? userLike.assignedSalonIds : [],
      permissions: Array.isArray(userLike.permissions) ? userLike.permissions : [],
    }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '30d' });
  }

  async function bootstrap() {
    await sequelize.sync();
    await ensureStudiosTable();
    await ensureStudioSubscriptionEntitlementsTable();
    await ensureSubscriptionPurchaseIntentsTable();
    await ensureAppleSubscriptionTransactionsTable();
    await ensureAppleServerNotificationInboxTable();
    await ensureGooglePlaySubscriptionTransactionsTable();
    await ensureGooglePubSubNotificationInboxTable();
    await sequelize.sync();
  }

  async function createUserForStudio(studio, {
    label,
    role = 'admin',
    permissions = ['settings', 'members', 'reservations', 'attendances', 'payments:create'],
    assignedSalonIds = [],
  } = {}) {
    return User.create({
      username: `${label}-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      password: 'x',
      role,
      assignedSalonIds,
      permissions,
      studioId: studio.id,
    });
  }

  async function createStudioWithUsers(label) {
    const unique = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const studio = await Studio.create({
      name: `Studio ${label}`,
      studioCode: `s${unique.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10)}`,
      email: null,
      phone: null,
      country: 'TR',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      subscriptionStatus: 'trial',
      subscriptionPlan: 'trial',
      trialEndsAt: addDays(new Date(), 7),
    });

    const admin = await createUserForStudio(studio, {
      label,
      role: 'admin',
      permissions: ['settings', 'members', 'reservations', 'attendances', 'payments:create'],
    });
    const instructor = await createUserForStudio(studio, {
      label,
      role: 'instructor',
      permissions: ['members', 'reservations', 'attendances'],
      assignedSalonIds: [1],
    });

    return { studio, admin, instructor };
  }

  async function clearEntitlements(studioId) {
    await StudioSubscriptionEntitlement.destroy({ where: { studioId } });
  }

  async function setLegacyStatus(studio, subscriptionStatus, trialEndsAt) {
    studio.subscriptionStatus = subscriptionStatus;
    studio.trialEndsAt = trialEndsAt;
    await studio.save({ fields: ['subscriptionStatus', 'trialEndsAt'] });
  }

  async function seedEntitlement(studioId, normalizedStatus, overrides = {}) {
    await clearEntitlements(studioId);

    const base = {
      studioId,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus,
      providerProductId: `p-${normalizedStatus}`,
      providerSubscriptionId: `phase326-${studioId}-${normalizedStatus}`,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addDays(new Date(), 30),
      trialEndsAt: null,
      autoRenewEnabled: true,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: new Date(),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      providerStateVersion: null,
      providerEventTime: new Date(),
    };

    return StudioSubscriptionEntitlement.create({
      ...base,
      ...overrides,
    });
  }

  function buildApp({ usersRouteOverride = null } = {}) {
    const authRoutes = require('../routes/auth');
    const registerRoutes = require('../routes/register');
    const usersRoutes = usersRouteOverride || require('../routes/settings/users');
    const salonsRoutes = require('../routes/settings/salons');
    const equipmentRoutes = require('../routes/settings/equipment');
    const lessonPackagesRoutes = require('../routes/settings/lessonPackages');
    const memberTypesRoutes = require('../routes/settings/memberTypes');
    const paymentMethodsRoutes = require('../routes/settings/paymentMethods');
    const membersRoutes = require('../routes/settings/members');
    const reservationsRoutes = require('../routes/settings/reservations');
    const paymentsRoutes = require('../routes/settings/payments');
    const attendancesRoutes = require('../routes/settings/attendances');
    const reportsRoutes = require('../routes/settings/reports');
    const expensesRoutes = require('../routes/settings/expenses');
    const manualCardUsagesRoutes = require('../routes/settings/manual-card-usages');
    const studioOnboardingRoutes = require('../routes/settings/studio-onboarding');
    const subscriptionRoutes = require('../routes/subscription');
    const subscriptionSettingsRoutes = require('../routes/settings/subscription');

    const app = express();
    app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }));
    app.use(bodyParser.json());

    app.use('/auth', authRoutes);
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

    app.get('/', (req, res) => res.send('Fitness Studio API running'));
    app.use((req, res) => res.status(404).json({ message: 'Not found' }));

    return app;
  }

  function startServer(app) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function stopServer(server) {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function requestJson(server, {
    method = 'GET',
    routePath = '/',
    token = null,
    body = undefined,
  } = {}) {
    return new Promise((resolve, reject) => {
      const payload = typeof body === 'undefined' ? null : JSON.stringify(body);
      const address = server.address();
      const headers = {};

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method,
        path: routePath,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch (error) {
              parsed = text;
            }
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            text,
          });
        });
      });

      req.on('error', reject);

      if (payload !== null) {
        req.write(payload);
      }

      req.end();
    });
  }

  function getRouterMiddlewareNames(router) {
    return (router.stack || [])
      .filter((layer) => !layer.route && layer.handle)
      .map((layer) => layer.handle.name)
      .filter(Boolean);
  }

  function findRoute(router, method, routePath) {
    const stack = Array.isArray(router && router.stack) ? router.stack : [];
    return stack.find((layer) => layer.route
      && layer.route.path === routePath
      && layer.route.methods
      && layer.route.methods[method]) || null;
  }

  async function snapshotCounts() {
    return {
      studios: await Studio.count(),
      users: await User.count(),
      members: await Member.count(),
      reservations: await Reservation.count(),
      payments: await Payment.count(),
      entitlements: await StudioSubscriptionEntitlement.count(),
      intents: await SubscriptionPurchaseIntent.count(),
      appleTransactions: await AppleSubscriptionTransaction.count(),
      googleTransactions: await GooglePlaySubscriptionTransaction.count(),
    };
  }

  function expect402(response, expected = {}) {
    assert.strictEqual(response.statusCode, 402);
    assert.deepStrictEqual(response.body, {
      error: 'SUBSCRIPTION_REQUIRED',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: Object.prototype.hasOwnProperty.call(expected, 'subscriptionStatus') ? expected.subscriptionStatus : null,
      normalizedStatus: Object.prototype.hasOwnProperty.call(expected, 'normalizedStatus') ? expected.normalizedStatus : null,
      trialExpired: Object.prototype.hasOwnProperty.call(expected, 'trialExpired') ? expected.trialExpired : null,
      recoveryAllowed: true,
    });
  }

  function expect503(response) {
    assert.strictEqual(response.statusCode, 503);
    assert.deepStrictEqual(response.body, {
      error: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
      code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    });
  }

  function loadUsersRouteWithFailingResolver() {
    const servicePath = require.resolve('../services/subscriptionAccessService');
    const middlewarePath = require.resolve('../middleware/requireActiveSubscription');
    const usersPath = require.resolve('../routes/settings/users');

    const serviceModule = require(servicePath);
    const originalResolver = serviceModule.resolveSubscriptionAccessDecision;
    const cachedMiddleware = require.cache[middlewarePath];
    const cachedUsers = require.cache[usersPath];

    try {
      serviceModule.resolveSubscriptionAccessDecision = async () => {
        throw new Error('simulated subscription resolver failure');
      };

      delete require.cache[middlewarePath];
      delete require.cache[usersPath];

      return require(usersPath);
    } finally {
      serviceModule.resolveSubscriptionAccessDecision = originalResolver;
      delete require.cache[middlewarePath];
      delete require.cache[usersPath];

      if (cachedMiddleware) {
        require.cache[middlewarePath] = cachedMiddleware;
      }
      if (cachedUsers) {
        require.cache[usersPath] = cachedUsers;
      }
    }
  }

  await bootstrap();

  const tenant = await createStudioWithUsers('tenant');
  const blockedAdminToken = makeToken(tenant.admin);
  const blockedInstructorToken = makeToken(tenant.instructor);

  const studioOne = await Studio.findByPk(1);
  assert.ok(studioOne, 'Expected Studio id=1 to exist');
  const studioOneAdmin = await createUserForStudio(studioOne, {
    label: 'studio-one',
    role: 'admin',
    permissions: ['settings', 'members', 'reservations', 'attendances', 'payments:create'],
  });
  const studioOneToken = makeToken(studioOneAdmin);

  const app = buildApp();
  const server = await startServer(app);

  try {
    await test('1) middleware is mounted on intended operational route groups with auth first', async () => {
      const protectedRouters = [
        '../routes/settings/users',
        '../routes/settings/salons',
        '../routes/settings/equipment',
        '../routes/settings/lessonPackages',
        '../routes/settings/memberTypes',
        '../routes/settings/paymentMethods',
        '../routes/settings/members',
        '../routes/settings/reservations',
        '../routes/settings/payments',
        '../routes/settings/attendances',
        '../routes/settings/reports',
        '../routes/settings/expenses',
        '../routes/settings/manual-card-usages',
      ].map((modulePath) => require(modulePath));

      for (const router of protectedRouters) {
        const names = getRouterMiddlewareNames(router);
        assert.strictEqual(names.filter((name) => name === 'authenticateToken').length, 1);
        assert.strictEqual(names.filter((name) => name === 'requireActiveSubscription').length, 1);
        assert.ok(names.indexOf('authenticateToken') < names.indexOf('requireActiveSubscription'));
      }

      const subscriptionRouter = require('../routes/subscription');
      const onboardingRouter = require('../routes/settings/studio-onboarding');
      const subscriptionSettingsRouter = require('../routes/settings/subscription');
      const backofficeAuthRouter = require('../routes/backoffice/auth');
      const backofficeOpsRouter = require('../routes/backoffice/ops');
      const backofficeStudiosRouter = require('../routes/backoffice/studios');

      for (const router of [subscriptionRouter, onboardingRouter, subscriptionSettingsRouter, backofficeAuthRouter, backofficeOpsRouter, backofficeStudiosRouter]) {
        const names = getRouterMiddlewareNames(router);
        assert.strictEqual(names.includes('requireActiveSubscription'), false);
      }
    });

    await test('2) valid legacy trial explicit token context allows protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'trial', addDays(new Date(), 5));
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('3) normalized trialing allows protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'trialing');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('4) normalized active allows protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'active');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('5) normalized grace_period allows protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'grace_period');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('6) normalized billing_retry allows protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'billing_retry');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('7) cancelled with future authoritative paid-through allows protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'cancelled', {
        currentPeriodEnd: addDays(new Date(), 2),
      });
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('8) paused returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'paused');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'paused' });
    });

    await test('9) pending returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'pending');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'pending' });
    });

    await test('10) expired returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'expired' });
    });

    await test('11) revoked returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'revoked');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'revoked' });
    });

    await test('12) refunded returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'refunded');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'refunded' });
    });

    await test('13) cancelled after period end returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'cancelled', {
        currentPeriodEnd: addDays(new Date(), -1),
      });
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'cancelled' });
    });

    await test('14) cancelled missing period end returns 402 on protected route', async () => {
      await seedEntitlement(tenant.studio.id, 'cancelled', {
        currentPeriodEnd: null,
      });
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'cancelled' });
    });

    await test('15) expired legacy trial returns 402 on protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'trial', addDays(new Date(), -1));
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { subscriptionStatus: 'trial', trialExpired: true });
    });

    await test('16) legacy active allows protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'active', null);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('17) legacy past_due returns 402 on protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'past_due', null);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { subscriptionStatus: 'past_due' });
    });

    await test('18) legacy suspended returns 402 on protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'suspended', null);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { subscriptionStatus: 'suspended' });
    });

    await test('19) legacy cancelled returns 402 on protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'cancelled', null);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { subscriptionStatus: 'cancelled' });
    });

    await test('20) fallback-derived Studio 1 context returns 503 on protected route', async () => {
      await clearEntitlements(tenant.studio.id);
      await setLegacyStatus(tenant.studio, 'active', null);
      const fallbackToken = makeFallbackToken(tenant.admin);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: fallbackToken });
      expect503(response);
    });

    await test('21) explicit legitimate Studio 1 context is evaluated normally', async () => {
      await clearEntitlements(studioOne.id);
      await setLegacyStatus(studioOne, 'active', null);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: studioOneToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('22) resolver or database failure returns 503 on protected route', async () => {
      const failingUsersRoute = loadUsersRouteWithFailingResolver();
      const failingApp = buildApp({ usersRouteOverride: failingUsersRoute });
      const failingServer = await startServer(failingApp);

      try {
        await clearEntitlements(tenant.studio.id);
        await setLegacyStatus(tenant.studio, 'active', null);
        const response = await requestJson(failingServer, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
        expect503(response);
      } finally {
        await stopServer(failingServer);
      }
    });

    await test('23) 402 payload matches exact contract', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'expired' });
      assert.deepStrictEqual(Object.keys(response.body).sort(), [
        'code',
        'error',
        'normalizedStatus',
        'recoveryAllowed',
        'subscriptionStatus',
        'trialExpired',
      ]);
    });

    await test('24) 503 payload matches exact contract', async () => {
      const fallbackToken = makeFallbackToken(tenant.admin);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: fallbackToken });
      expect503(response);
    });

    await test('25) 402 does not invalidate authentication', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const blocked = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(blocked, { normalizedStatus: 'expired' });

      const me = await requestJson(server, { method: 'GET', routePath: '/auth/me', token: blockedAdminToken });
      assert.strictEqual(me.statusCode, 200);
      assert.strictEqual(me.body.id, tenant.admin.id);
      assert.strictEqual(me.body.studioId, tenant.studio.id);
    });

    await test('26) subscription status remains accessible while operational route returns 402', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const blocked = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(blocked, { normalizedStatus: 'expired' });

      const status = await requestJson(server, { method: 'GET', routePath: '/subscription/status', token: blockedAdminToken });
      assert.strictEqual(status.statusCode, 200);
    });

    await test('27) catalog remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/subscription/catalog', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
      assert.ok(response.body && Array.isArray(response.body.plans));
    });

    await test('28) Apple purchase-intent remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/apple/purchase-intent',
        token: blockedAdminToken,
        body: { plan: 'invalid' },
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_SUBSCRIPTION_PLAN' });
    });

    await test('29) Google purchase-intent remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/google-play/purchase-intent',
        token: blockedAdminToken,
        body: { plan: 'invalid' },
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_SUBSCRIPTION_PLAN' });
    });

    await test('30) Apple verify remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/apple/verify-purchase',
        token: blockedAdminToken,
        body: {},
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_PURCHASE_VERIFICATION_REQUEST' });
    });

    await test('31) Google verify remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/google-play/verify-purchase',
        token: blockedAdminToken,
        body: {},
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_PURCHASE_VERIFICATION_REQUEST' });
    });

    await test('32) Apple restore remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/apple/restore',
        token: blockedAdminToken,
        body: { signedTransactionInfo: 'not-jws' },
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_RESTORE_REQUEST' });
    });

    await test('33) Google restore remains accessible while blocked', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/google-play/restore',
        token: blockedAdminToken,
        body: { purchaseToken: '' },
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'INVALID_RESTORE_REQUEST' });
    });

    await test('34) subscription management route remains accessible', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/subscription', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
    });

    await test('35) auth/me remains accessible', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/auth/me', token: blockedAdminToken });
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body.id, tenant.admin.id);
    });

    await test('36) password-change route remains outside subscription gate', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, {
        method: 'PATCH',
        routePath: '/auth/me/password',
        token: blockedAdminToken,
        body: {},
      });
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'Missing required fields: oldPassword, newPassword' });
    });

    await test('37) onboarding route remains outside subscription gate', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/studio/onboarding', token: blockedAdminToken });
      assert.notStrictEqual(response.statusCode, 402);
      assert.notStrictEqual(response.statusCode, 503);
    });

    await test('38) Apple notification webhook remains outside subscription gate', async () => {
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/apple/notifications',
        body: {},
      });
      assert.notStrictEqual(response.statusCode, 402);
      assert.notStrictEqual(response.statusCode, 503);
    });

    await test('39) Google notification webhook remains outside subscription gate', async () => {
      const response = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/google-play/notifications',
        body: {},
      });
      assert.notStrictEqual(response.statusCode, 402);
      assert.notStrictEqual(response.statusCode, 503);
    });

    await test('40) backoffice routes remain outside tenant subscription gate', async () => {
      const response = await requestJson(server, { method: 'GET', routePath: '/backoffice/ops/summary' });
      assert.strictEqual(response.statusCode, 404);

      const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
      assert.ok(appSource.includes('BACKOFFICE_ENABLED'));
      assert.ok(appSource.includes("['1', 'true']"));
    });

    await test('41) instructor operational route is blocked when tenant is ineffective', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users/instructors', token: blockedInstructorToken });
      expect402(response, { normalizedStatus: 'expired' });
    });

    await test('42) admin operational route is blocked when tenant is ineffective', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'expired' });
    });

    await test('43) no billing privilege is added to instructor', async () => {
      const subscriptionRouter = require('../routes/subscription');
      const purchaseIntentRoute = findRoute(subscriptionRouter, 'post', '/apple/purchase-intent');
      assert.ok(purchaseIntentRoute);
      const handlers = purchaseIntentRoute.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);
      assert.deepStrictEqual(handlers, ['authenticateToken', 'createApplePurchaseIntent']);
    });

    await test('44) 402 denial causes no domain data mutation', async () => {
      await seedEntitlement(tenant.studio.id, 'expired');
      const before = await snapshotCounts();
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: blockedAdminToken });
      expect402(response, { normalizedStatus: 'expired' });
      const after = await snapshotCounts();
      assert.deepStrictEqual(after, before);
    });

    await test('45) 503 denial causes no domain data mutation', async () => {
      const before = await snapshotCounts();
      const fallbackToken = makeFallbackToken(tenant.admin);
      const response = await requestJson(server, { method: 'GET', routePath: '/settings/users', token: fallbackToken });
      expect503(response);
      const after = await snapshotCounts();
      assert.deepStrictEqual(after, before);
    });

    await test('46) JWT payload shape remains unchanged', async () => {
      const authTokenSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'authToken.js'), 'utf8');
      assert.ok(authTokenSource.includes('id: userLike.id'));
      assert.ok(authTokenSource.includes('role: userLike.role'));
      assert.ok(authTokenSource.includes('assignedSalonIds'));
      assert.ok(authTokenSource.includes('permissions'));
      assert.ok(authTokenSource.includes('studioId'));
    });

    await test('47) login response shape remains unchanged', async () => {
      const authRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
      assert.ok(authRouteSource.includes('token,'));
      assert.ok(authRouteSource.includes('role: payload.role'));
      assert.ok(authRouteSource.includes('assignedSalonIds: payload.assignedSalonIds'));
      assert.ok(authRouteSource.includes('permissions: payload.permissions'));
      assert.ok(authRouteSource.includes('studioId: payload.studioId'));
      assert.ok(authRouteSource.includes('studioCode: studio.studioCode'));
    });

    await test('48) registration response shape remains unchanged', async () => {
      const registerSource = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'registerController.js'), 'utf8');
      assert.ok(registerSource.includes("message: 'Studio registered successfully'"));
      assert.ok(registerSource.includes('token,'));
      assert.ok(registerSource.includes('user: {'));
      assert.ok(registerSource.includes('studio: {'));
    });

    await test('49) purchase and restore contracts do not regress and no web payment is added', async () => {
      configureCatalogEnv();
      await seedEntitlement(tenant.studio.id, 'expired');

      const appleIntent = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/apple/purchase-intent',
        token: blockedAdminToken,
        body: { plan: 'invalid' },
      });
      assert.deepStrictEqual(appleIntent.body, { error: 'INVALID_SUBSCRIPTION_PLAN' });

      const googleRestore = await requestJson(server, {
        method: 'POST',
        routePath: '/subscription/google-play/restore',
        token: blockedAdminToken,
        body: { purchaseToken: '' },
      });
      assert.deepStrictEqual(googleRestore.body, { error: 'INVALID_RESTORE_REQUEST' });

      const packageJsonSource = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8').toLowerCase();
      assert.strictEqual(packageJsonSource.includes('stripe'), false);
      assert.strictEqual(packageJsonSource.includes('web payment'), false);
    });

    await test('50) health route remains public and recovery surfaces stay ungated', async () => {
      const health = await requestJson(server, { method: 'GET', routePath: '/' });
      assert.strictEqual(health.statusCode, 200);
      assert.strictEqual(health.text, 'Fitness Studio API running');
    });
  } finally {
    await stopServer(server);
  }

  report.summary = {
    passed: report.testsPassed.length,
    failed: report.testsFailed.length,
  };

  console.log(JSON.stringify(report, null, 2));

  await sequelize.close();

  if (report.testsFailed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});