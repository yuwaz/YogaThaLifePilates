const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const ORIGINAL_ENV = {
  DB_PATH: process.env.DB_PATH,
  JWT_SECRET: process.env.JWT_SECRET,
  PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
  PLATFORM_JWT_EXPIRES_IN: process.env.PLATFORM_JWT_EXPIRES_IN,
  BACKOFFICE_ENABLED: process.env.BACKOFFICE_ENABLED,
};

process.env.JWT_SECRET = 'phase327-tenant-secret-tenant-secret-12345';
process.env.PLATFORM_JWT_SECRET = 'phase327-platform-secret-platform-secret-12345';
delete process.env.PLATFORM_JWT_EXPIRES_IN;

const { buildAuthPayload, signAuthToken } = require('../utils/authToken');

let authenticateToken;
let requireActiveSubscription;
let resolveSubscriptionAccessDecision;
let backofficeStudioWriteService;

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase327-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    PlatformAdmin,
    PlatformAuditLog,
    StudioManualSubscriptionOverride,
    StudioSubscriptionEntitlement,
    SubscriptionPurchaseIntent,
    AppleSubscriptionTransaction,
    GooglePlaySubscriptionTransaction,
  } = require('../models');

  ({ authenticateToken } = require('../middleware/auth'));
  requireActiveSubscription = require('../middleware/requireActiveSubscription');
  ({ resolveSubscriptionAccessDecision } = require('../services/subscriptionAccessService'));
  backofficeStudioWriteService = require('../services/backofficeStudioWriteService');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

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
    }
  }

  function addSeconds(baseDate, seconds) {
    return new Date(baseDate.getTime() + seconds * 1000);
  }

  function addDays(baseDate, days) {
    return new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
  }

  function buildTenantToken(userLike, includeStudioId = true) {
    const payload = buildAuthPayload(userLike);
    if (!includeStudioId) {
      delete payload.studioId;
    }
    return signAuthToken(payload);
  }

  function buildPlatformToken(adminId, expiresIn = '30m') {
    return jwt.sign(
      { tokenType: 'platform' },
      process.env.PLATFORM_JWT_SECRET,
      {
        subject: String(adminId),
        audience: 'backoffice',
        issuer: 'yogatha-platform',
        expiresIn,
      }
    );
  }

  function buildExpiredPlatformToken(adminId) {
    return jwt.sign(
      {
        tokenType: 'platform',
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      process.env.PLATFORM_JWT_SECRET,
      {
        subject: String(adminId),
        audience: 'backoffice',
        issuer: 'yogatha-platform',
        noTimestamp: true,
      }
    );
  }

  function createApp(backofficeEnabled) {
    const app = express();
    app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }));
    app.use(bodyParser.json());

    app.get('/tenant/protected', authenticateToken, requireActiveSubscription, (req, res) => {
      res.status(200).json({ ok: true, studioId: req.user.studioId });
    });

    if (backofficeEnabled) {
      app.use('/backoffice/auth', require('../routes/backoffice/auth'));
      app.use('/backoffice/ops', require('../routes/backoffice/ops'));
      app.use('/backoffice/studios', require('../routes/backoffice/studios'));
    }

    app.use((req, res) => res.status(404).json({ message: 'Not found' }));
    return app;
  }

  async function listen(app) {
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return { server, baseUrl };
  }

  async function requestJson(baseUrl, method, pathname, { token, body } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    return {
      status: response.status,
      body: parsed,
      text,
    };
  }

  async function bootstrap() {
    await sequelize.sync();
  }

  async function createStudio(label, overrides = {}) {
    const unique = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return Studio.create({
      name: `Studio ${label}`,
      studioCode: `s${unique.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10)}`,
      email: null,
      phone: null,
      country: 'TR',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      subscriptionStatus: 'trial',
      subscriptionPlan: 'trial',
      trialEndsAt: addSeconds(new Date(), 3600),
      ...overrides,
    });
  }

  async function createTenantUser(studio, label) {
    return User.create({
      username: `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      password: 'tenant-password',
      role: 'admin',
      assignedSalonIds: [],
      permissions: [],
      studioId: studio.id,
    });
  }

  async function seedEntitlement(studioId, normalizedStatus, overrides = {}) {
    await StudioSubscriptionEntitlement.destroy({ where: { studioId } });

    const now = new Date();
    return StudioSubscriptionEntitlement.create({
      studioId,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus,
      providerProductId: `phase327-${normalizedStatus}`,
      providerSubscriptionId: `phase327-sub-${studioId}-${normalizedStatus}`,
      currentPeriodStart: now,
      currentPeriodEnd: addDays(now, 30),
      trialEndsAt: null,
      autoRenewEnabled: true,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: now,
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      providerStateVersion: null,
      providerEventTime: now,
      ...overrides,
    });
  }

  async function getAuthorityTableCounts() {
    const [entitlements, purchaseIntents, appleTx, googleTx] = await Promise.all([
      StudioSubscriptionEntitlement.count(),
      SubscriptionPurchaseIntent.count(),
      AppleSubscriptionTransaction.count(),
      GooglePlaySubscriptionTransaction.count(),
    ]);

    return {
      entitlements,
      purchaseIntents,
      appleTx,
      googleTx,
    };
  }

  await bootstrap();

  const activeStudio = await createStudio('active', {
    subscriptionStatus: 'active',
    subscriptionPlan: 'basic',
  });
  const suspendedStudio = await createStudio('suspended', {
    subscriptionStatus: 'suspended',
    subscriptionPlan: 'basic',
  });
  const overrideGrantStudio = await createStudio('override-grant', {
    subscriptionStatus: 'suspended',
    subscriptionPlan: 'basic',
  });
  const overrideDenyStudio = await createStudio('override-deny', {
    subscriptionStatus: 'active',
    subscriptionPlan: 'basic',
  });
  const overrideTemporalStudio = await createStudio('override-temporal', {
    subscriptionStatus: 'active',
    subscriptionPlan: 'basic',
  });
  const overrideIsolationStudio = await createStudio('override-isolation', {
    subscriptionStatus: 'suspended',
    subscriptionPlan: 'basic',
  });

  const tenantUser = await createTenantUser(activeStudio, 'tenant');
  const tenantTokenWithStudio = buildTenantToken(tenantUser, true);
  const tenantLegacyToken = buildTenantToken(tenantUser, false);

  const adminPassword = 'CorrectHorseBatteryStaple!1';
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

  const activeAdmin = await PlatformAdmin.create({
    email: 'admin@example.com',
    passwordHash: adminPasswordHash,
    status: 'active',
    mfaRequired: false,
  });
  const disabledAdmin = await PlatformAdmin.create({
    email: 'disabled@example.com',
    passwordHash: adminPasswordHash,
    status: 'disabled',
    mfaRequired: false,
  });
  const activeAdminToken = buildPlatformToken(activeAdmin.id);
  const disabledAdminToken = buildPlatformToken(disabledAdmin.id);
  const expiredAdminToken = buildExpiredPlatformToken(activeAdmin.id);
  const malformedAdminToken = 'not-a-jwt';
  const tenantToken = tenantTokenWithStudio;

  const disabledApp = createApp(false);
  const enabledApp = createApp(true);
  const disabledServer = await listen(disabledApp);
  const enabledServer = await listen(enabledApp);

  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

    await test('1) BACKOFFICE_ENABLED gate is explicit and fail-closed', async () => {
      assert(source.includes("['1', 'true']"));
      assert(source.includes('backofficeEnabled'));
      assert(!source.includes("['1', 'true', 'yes'"));
    });

    await test('2) backoffice routes stay unmounted when disabled', async () => {
      const response = await requestJson(disabledServer.baseUrl, 'GET', '/backoffice/auth/login');
      assert.strictEqual(response.status, 404);
    });

    await test('3) backoffice routes mount when explicitly enabled', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', { body: {} });
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body.error, 'INVALID_REQUEST');
    });

    await test('4) tenant route behavior remains intact', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/tenant/protected', { token: tenantTokenWithStudio });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.ok, true);
      assert.strictEqual(response.body.studioId, activeStudio.id);
    });

    await test('5) tenant legacy token still triggers subscription check unavailable', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/tenant/protected', { token: tenantLegacyToken });
      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.body.error, 'SUBSCRIPTION_CHECK_UNAVAILABLE');
    });

    await test('6) tenant JWT is rejected from backoffice route', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/ops/summary', { token: tenantToken });
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.error, 'PLATFORM_AUTH_REQUIRED');
    });

    await test('7) PlatformAdmin JWT is rejected by tenant route', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/tenant/protected', { token: activeAdminToken });
      assert.strictEqual(response.status, 403);
    });

    await test('8) valid PlatformAdmin token is accepted', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/ops/summary', { token: activeAdminToken });
      assert.strictEqual(response.status, 200);
      assert.ok(response.body.summary);
    });

    await test('9) malformed PlatformAdmin token is rejected', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/ops/summary', { token: malformedAdminToken });
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.error, 'PLATFORM_AUTH_REQUIRED');
    });

    await test('10) expired PlatformAdmin token is rejected', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/ops/summary', { token: expiredAdminToken });
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.error, 'PLATFORM_AUTH_REQUIRED');
    });

    await test('11) inactive PlatformAdmin is rejected', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/ops/summary', { token: disabledAdminToken });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, 'PLATFORM_ACCESS_DENIED');
    });

    await test('12) PlatformAdmin login failure does not reveal existence', async () => {
      const missingAdmin = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', {
        body: { email: 'missing@example.com', password: 'WrongPassword!123' },
      });
      const wrongPassword = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', {
        body: { email: 'admin@example.com', password: 'WrongPassword!123' },
      });

      assert.strictEqual(missingAdmin.status, 401);
      assert.strictEqual(wrongPassword.status, 401);
      assert.strictEqual(missingAdmin.body.error, 'INVALID_CREDENTIALS');
      assert.strictEqual(wrongPassword.body.error, 'INVALID_CREDENTIALS');
    });

    await test('13) PlatformAdmin login returns safe payload only', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', {
        body: { email: 'admin@example.com', password: adminPassword },
      });

      assert.strictEqual(response.status, 200);
      assert.ok(response.body.accessToken);
      assert.ok(response.body.platformAdmin);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body.platformAdmin, 'passwordHash'), false);
    });

    await test('14) repeated failed login attempts are throttled', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', {
          body: { email: 'throttle@example.com', password: 'WrongPassword!123' },
        });
        assert.strictEqual(response.status, 401);
      }

      const throttled = await requestJson(enabledServer.baseUrl, 'POST', '/backoffice/auth/login', {
        body: { email: 'throttle@example.com', password: 'WrongPassword!123' },
      });

      assert.strictEqual(throttled.status, 429);
      assert.strictEqual(throttled.body.error, 'PLATFORM_LOGIN_RATE_LIMITED');
    });

    await test('15) no override + active entitlement -> allowed', async () => {
      await seedEntitlement(activeStudio.id, 'active');
      const decision = await resolveSubscriptionAccessDecision({ studioId: activeStudio.id });
      assert.strictEqual(decision.operationalAccess, true);
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.normalizedStatus, 'active');
    });

    await test('16) no override + inactive entitlement -> denied', async () => {
      await seedEntitlement(activeStudio.id, 'expired');
      const decision = await resolveSubscriptionAccessDecision({ studioId: activeStudio.id });
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.normalizedStatus, 'expired');
    });

    await test('17) suspendStudio writes an audit record safely', async () => {
      const beforeCount = await PlatformAuditLog.count();
      const result = await backofficeStudioWriteService.suspendStudio({
        actorPlatformAdminId: activeAdmin.id,
        studioId: activeStudio.id,
        reason: 'Investigating billing issue',
        requestMetadata: {
          requestId: 'req-suspend-1',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      assert.strictEqual(result.studio.operationalStatus, 'suspended');
      const afterCount = await PlatformAuditLog.count();
      assert.strictEqual(afterCount, beforeCount + 1);

      const logEntry = await PlatformAuditLog.findOne({ order: [['id', 'DESC']] });
      assert.strictEqual(logEntry.actionType, 'studio.suspend');
      assert.strictEqual(logEntry.actorPlatformAdminId, activeAdmin.id);
      assert.strictEqual(logEntry.studioId, activeStudio.id);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(logEntry.beforeSnapshot || {}, 'passwordHash'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(logEntry.afterSnapshot || {}, 'passwordHash'), false);
    });

    await test('18) active grant override -> allowed and provider authority rows unchanged', async () => {
      await seedEntitlement(overrideGrantStudio.id, 'expired');
      const beforeAuthority = await getAuthorityTableCounts();

      const setResult = await backofficeStudioWriteService.setManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideGrantStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'active',
        effectiveFrom: addSeconds(new Date(), -30),
        expiresAt: addSeconds(new Date(), 3600),
        reason: 'Grant temporary access for platform intervention',
        requestMetadata: {
          requestId: 'req-override-grant-set',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      const decision = await resolveSubscriptionAccessDecision({ studioId: overrideGrantStudio.id });
      assert.strictEqual(decision.operationalAccess, true);
      assert.strictEqual(decision.decisionSource, 'manual_override');
      assert.strictEqual(decision.subscriptionStatus, 'active');
      assert.ok(setResult.manualOverride);

      const afterAuthority = await getAuthorityTableCounts();
      assert.strictEqual(afterAuthority.entitlements, beforeAuthority.entitlements);
      assert.strictEqual(afterAuthority.purchaseIntents, beforeAuthority.purchaseIntents);
      assert.strictEqual(afterAuthority.appleTx, beforeAuthority.appleTx);
      assert.strictEqual(afterAuthority.googleTx, beforeAuthority.googleTx);
    });

    await test('19) active deny override -> denied', async () => {
      await seedEntitlement(overrideDenyStudio.id, 'active');

      const setResult = await backofficeStudioWriteService.setManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideDenyStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'suspended',
        effectiveFrom: addSeconds(new Date(), -30),
        expiresAt: addSeconds(new Date(), 3600),
        reason: 'Temporarily force-deny access',
        requestMetadata: {
          requestId: 'req-override-deny-set',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      const decision = await resolveSubscriptionAccessDecision({ studioId: overrideDenyStudio.id });
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.decisionSource, 'manual_override');
      assert.strictEqual(decision.subscriptionStatus, 'suspended');
      assert.ok(setResult.manualOverride);
    });

    await test('20) revoked/expired/future overrides are ignored safely', async () => {
      await seedEntitlement(overrideTemporalStudio.id, 'expired');

      await backofficeStudioWriteService.setManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideTemporalStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'active',
        effectiveFrom: addSeconds(new Date(), -30),
        expiresAt: addSeconds(new Date(), 60),
        reason: 'Temporal override baseline',
        requestMetadata: {
          requestId: 'req-temporal-baseline',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      await backofficeStudioWriteService.revokeManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideTemporalStudio.id,
        reason: 'Revoke baseline override',
        requestMetadata: {
          requestId: 'req-temporal-revoke',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      await Studio.update(
        { subscriptionStatus: 'active' },
        { where: { id: overrideTemporalStudio.id } }
      );

      await StudioManualSubscriptionOverride.create({
        studioId: overrideTemporalStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'active',
        effectiveFrom: addSeconds(new Date(), -300),
        expiresAt: addSeconds(new Date(), -60),
        reason: 'Expired override should be ignored',
        createdByPlatformAdminId: activeAdmin.id,
        previousSubscriptionPlan: 'basic',
        previousSubscriptionStatus: 'suspended',
        previousTrialEndsAt: null,
      });

      let decision = await resolveSubscriptionAccessDecision({ studioId: overrideTemporalStudio.id });
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.normalizedStatus, 'expired');

      await StudioManualSubscriptionOverride.destroy({
        where: {
          studioId: overrideTemporalStudio.id,
          revokedAt: null,
        },
      });

      await StudioManualSubscriptionOverride.create({
        studioId: overrideTemporalStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'active',
        effectiveFrom: addSeconds(new Date(), 300),
        expiresAt: addSeconds(new Date(), 900),
        reason: 'Future override should be ignored',
        createdByPlatformAdminId: activeAdmin.id,
        previousSubscriptionPlan: 'basic',
        previousSubscriptionStatus: 'suspended',
        previousTrialEndsAt: null,
      });

      decision = await resolveSubscriptionAccessDecision({ studioId: overrideTemporalStudio.id });
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.normalizedStatus, 'expired');
    });

    await test('21) malformed date or unknown override status fails closed', async () => {
      const fakeStudioModel = {
        async findByPk() {
          return { id: 1, subscriptionStatus: 'active', trialEndsAt: null };
        },
      };
      const fakeEntitlementModel = {
        async findOne() {
          return null;
        },
      };

      const malformedDecision = await resolveSubscriptionAccessDecision({
        studioId: 1,
        dependencies: {
          StudioModel: fakeStudioModel,
          EntitlementModel: fakeEntitlementModel,
          ManualOverrideModel: {
            async findOne() {
              return {
                subscriptionStatus: 'active',
                effectiveFrom: 'not-a-date',
                expiresAt: null,
                previousSubscriptionStatus: 'active',
                previousTrialEndsAt: null,
              };
            },
          },
        },
      });
      assert.strictEqual(malformedDecision.operationalAccess, false);
      assert.strictEqual(malformedDecision.decisionSource, 'manual_override');

      const unknownStatusDecision = await resolveSubscriptionAccessDecision({
        studioId: 1,
        dependencies: {
          StudioModel: fakeStudioModel,
          EntitlementModel: fakeEntitlementModel,
          ManualOverrideModel: {
            async findOne() {
              return {
                subscriptionStatus: 'unknown-status',
                effectiveFrom: new Date(),
                expiresAt: addSeconds(new Date(), 120),
                previousSubscriptionStatus: 'active',
                previousTrialEndsAt: null,
              };
            },
          },
        },
      });
      assert.strictEqual(unknownStatusDecision.operationalAccess, false);
      assert.strictEqual(unknownStatusDecision.decisionSource, 'manual_override');
    });

    await test('22) cross-studio override cannot affect another studio', async () => {
      await seedEntitlement(overrideIsolationStudio.id, 'expired');
      await seedEntitlement(activeStudio.id, 'expired');

      await backofficeStudioWriteService.setManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideIsolationStudio.id,
        subscriptionPlan: 'basic',
        subscriptionStatus: 'active',
        effectiveFrom: addSeconds(new Date(), -30),
        expiresAt: addSeconds(new Date(), 300),
        reason: 'Studio-local override',
        requestMetadata: {
          requestId: 'req-override-isolation',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });

      const decision = await resolveSubscriptionAccessDecision({ studioId: activeStudio.id });
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.normalizedStatus, 'expired');
    });

    await test('23) revoke returns resolver to underlying entitlement decision', async () => {
      const beforeCount = await PlatformAuditLog.count();

      const revokeResult = await backofficeStudioWriteService.revokeManualSubscriptionOverride({
        actorPlatformAdminId: activeAdmin.id,
        studioId: overrideGrantStudio.id,
        reason: 'Ending temporary grant',
        requestMetadata: {
          requestId: 'req-override-grant-revoke',
          ip: '127.0.0.1',
          userAgent: 'phase327-validator',
        },
      });
      assert.ok(revokeResult.manualOverride.revokedAt);

      const decision = await resolveSubscriptionAccessDecision({ studioId: overrideGrantStudio.id });
      assert.strictEqual(decision.decisionSource, 'entitlement');
      assert.strictEqual(decision.operationalAccess, false);
      assert.strictEqual(decision.normalizedStatus, 'expired');

      const afterCount = await PlatformAuditLog.count();
      assert.strictEqual(afterCount, beforeCount + 1);
    });

    await test('24) repeat reads are deterministic', async () => {
      const first = await resolveSubscriptionAccessDecision({ studioId: overrideDenyStudio.id });
      const second = await resolveSubscriptionAccessDecision({ studioId: overrideDenyStudio.id });
      assert.strictEqual(first.operationalAccess, second.operationalAccess);
      assert.strictEqual(first.decisionSource, second.decisionSource);
      assert.strictEqual(first.subscriptionStatus, second.subscriptionStatus);
      assert.strictEqual(first.normalizedStatus, second.normalizedStatus);
    });

    await test('25) operationalStatus remains outside resolver policy', async () => {
      await seedEntitlement(suspendedStudio.id, 'active');
      await Studio.update(
        { operationalStatus: 'suspended' },
        { where: { id: suspendedStudio.id } }
      );

      const decision = await resolveSubscriptionAccessDecision({ studioId: suspendedStudio.id });
      assert.strictEqual(decision.operationalAccess, true);
      assert.strictEqual(decision.decisionSource, 'entitlement');
    });

    await test('26) 402 contract remains unchanged', async () => {
      await seedEntitlement(activeStudio.id, 'expired');
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/tenant/protected', { token: tenantTokenWithStudio });
      assert.strictEqual(response.status, 402);
      assert.strictEqual(response.body.error, 'SUBSCRIPTION_REQUIRED');
      assert.strictEqual(response.body.code, 'SUBSCRIPTION_REQUIRED');
      assert.strictEqual(response.body.recoveryAllowed, true);
      assert.strictEqual(typeof response.body.normalizedStatus, 'string');
    });

    await test('27) 503 contract remains unchanged', async () => {
      const response = await requestJson(enabledServer.baseUrl, 'GET', '/tenant/protected', { token: tenantLegacyToken });
      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.body.error, 'SUBSCRIPTION_CHECK_UNAVAILABLE');
      assert.strictEqual(response.body.code, 'SUBSCRIPTION_CHECK_UNAVAILABLE');
    });

    await test('28) protected studio routes remain protected', async () => {
      const noAuth = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/studios');
      assert.strictEqual(noAuth.status, 401);

      const withToken = await requestJson(enabledServer.baseUrl, 'GET', '/backoffice/studios', { token: activeAdminToken });
      assert.strictEqual(withToken.status, 200);
      assert.ok(Array.isArray(withToken.body.items));
    });

    await test('29) protected studio detail route remains protected', async () => {
      const noAuth = await requestJson(enabledServer.baseUrl, 'GET', `/backoffice/studios/${activeStudio.id}`);
      assert.strictEqual(noAuth.status, 401);

      const withToken = await requestJson(enabledServer.baseUrl, 'GET', `/backoffice/studios/${activeStudio.id}`, { token: activeAdminToken });
      assert.strictEqual(withToken.status, 200);
      assert.strictEqual(withToken.body.studio.id, activeStudio.id);
    });

    await test('30) exact future bootstrap CLI syntax stays stable', async () => {
      const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'managePlatformAdmin.js'), 'utf8');
      assert(scriptSource.includes('node scripts/managePlatformAdmin.js create --email admin@example.com [--reason "..."] [--password-stdin]'));
      assert(scriptSource.includes('node scripts/managePlatformAdmin.js disable --email admin@example.com --reason "..."'));
      assert(scriptSource.includes('node scripts/managePlatformAdmin.js enable --email admin@example.com --reason "..."'));
      assert(scriptSource.includes('node scripts/managePlatformAdmin.js reset-password --email admin@example.com --reason "..." [--password-stdin]'));
    });
  } finally {
    await new Promise((resolve) => disabledServer.server.close(resolve));
    await new Promise((resolve) => enabledServer.server.close(resolve));
    await sequelize.close();

    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.testsFailed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    disposableDbPath: process.env.DB_PATH,
    testsPassed: [],
    testsFailed: [{
      name: 'validator crashed',
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : 'Unknown error',
    }],
  }, null, 2));
  process.exitCode = 1;
});
