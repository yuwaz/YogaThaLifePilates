const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase325-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
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

  const requireActiveSubscription = require('../middleware/requireActiveSubscription');
  const {
    resolveSubscriptionAccessDecision,
    ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES,
  } = require('../services/subscriptionAccessService');
  const subscriptionRoute = require('../routes/subscription');

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

  function addDays(baseDate, days) {
    return new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
  }

  function findRoute(router, method, pathValue) {
    const stack = Array.isArray(router && router.stack) ? router.stack : [];
    return stack.find((layer) => {
      if (!layer || !layer.route || !layer.route.methods) {
        return false;
      }

      return layer.route.path === pathValue && Boolean(layer.route.methods[method]);
    }) || null;
  }

  function makeRes() {
    return {
      statusCode: null,
      payload: null,
      sendStatus(code) {
        this.statusCode = code;
        this.payload = null;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        return this;
      },
    };
  }

  async function runMiddleware(req) {
    const res = makeRes();
    let nextCalled = false;

    await requireActiveSubscription(req, res, () => {
      nextCalled = true;
    });

    return { res, nextCalled };
  }

  async function createStudioWithUser(label) {
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

    const user = await User.create({
      username: `user-${unique}`,
      password: 'x',
      role: 'admin',
      assignedSalonIds: [],
      permissions: [],
      studioId: studio.id,
    });

    return { studio, user };
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
      providerSubscriptionId: `token-${studioId}-${normalizedStatus}`,
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

  await bootstrap();

  const { studio: studioA } = await createStudioWithUser('A');
  const { studio: studioB } = await createStudioWithUser('B');

  await test('1) middleware remains unmounted in app.js', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.strictEqual(appSource.includes('requireActiveSubscription'), false);
  });

  await test('2) normalized trialing -> operational access', async () => {
    await seedEntitlement(studioA.id, 'trialing');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.ok, true);
    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'trialing');
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('3) normalized active -> operational access', async () => {
    await seedEntitlement(studioA.id, 'active');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('4) normalized grace_period -> operational access', async () => {
    await seedEntitlement(studioA.id, 'grace_period');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('5) normalized billing_retry -> operational access', async () => {
    await seedEntitlement(studioA.id, 'billing_retry');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('6) normalized paused -> denied', async () => {
    await seedEntitlement(studioA.id, 'paused');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
    assert.strictEqual(decision.recoveryAllowed, true);
  });

  await test('7) normalized none -> denied', async () => {
    await seedEntitlement(studioA.id, 'none');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('8) normalized pending -> denied', async () => {
    await seedEntitlement(studioA.id, 'pending');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('9) normalized expired -> denied', async () => {
    await seedEntitlement(studioA.id, 'expired');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('10) normalized revoked -> denied', async () => {
    await seedEntitlement(studioA.id, 'revoked');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11) normalized refunded -> denied', async () => {
    await seedEntitlement(studioA.id, 'refunded');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11.1) normalized cancelled + authoritative future period end -> operational', async () => {
    const fixedNow = new Date('2030-01-01T00:00:00.000Z');
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: addDays(fixedNow, 7),
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'cancelled');
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('11.2) normalized cancelled + boundary period end equal now -> denied', async () => {
    const fixedNow = new Date('2030-01-02T00:00:00.000Z');
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: new Date(fixedNow.getTime()),
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11.3) normalized cancelled + past period end -> denied', async () => {
    const fixedNow = new Date('2030-01-03T00:00:00.000Z');
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: addDays(fixedNow, -1),
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11.4) normalized cancelled + missing period end -> denied', async () => {
    const fixedNow = new Date('2030-01-04T00:00:00.000Z');
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: null,
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11.5) normalized cancelled + malformed period end -> denied safely', async () => {
    const fixedNow = new Date('2030-01-05T00:00:00.000Z');
    await clearEntitlements(studioA.id);
    await sequelize.query(
      `INSERT INTO StudioSubscriptionEntitlements (
        studioId, provider, plan, normalizedStatus, providerProductId, providerSubscriptionId,
        currentPeriodEnd, sourceLastUpdate, environment, createdAt, updatedAt
      ) VALUES (?, 'google_play', 'basic', 'cancelled', 'p-cancelled-malformed', ?, 'not-a-date', 'verify_endpoint', 'production', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      { replacements: [studioA.id, `cancelled-malformed-${studioA.id}`] }
    );

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'cancelled');
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('11.6) paused/expired/revoked/refunded remain denied even with future period end', async () => {
    const fixedNow = new Date('2030-01-06T00:00:00.000Z');
    const statuses = ['paused', 'expired', 'revoked', 'refunded'];

    for (const status of statuses) {
      await seedEntitlement(studioA.id, status, {
        currentPeriodEnd: addDays(fixedNow, 5),
      });

      const decision = await resolveSubscriptionAccessDecision({
        studioId: studioA.id,
        now: fixedNow,
      });

      assert.strictEqual(decision.normalizedStatus, status);
      assert.strictEqual(decision.operationalAccess, false);
    }
  });

  await test('12) normalized unknown -> denied safely', async () => {
    await clearEntitlements(studioA.id);
    await sequelize.query(
      `INSERT INTO StudioSubscriptionEntitlements (
        studioId, provider, plan, normalizedStatus, providerProductId, providerSubscriptionId,
        sourceLastUpdate, environment, createdAt, updatedAt
      ) VALUES (?, 'google_play', 'basic', 'mystery_status', 'p-unknown', ?, 'verify_endpoint', 'production', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      { replacements: [studioA.id, `unknown-${studioA.id}`] }
    );

    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.ok, true);
    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'unknown');
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('13) entitlement precedence over legacy active', async () => {
    await setLegacyStatus(studioA, 'active', null);
    await seedEntitlement(studioA.id, 'expired');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'expired');
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('14) entitlement precedence over legacy inactive', async () => {
    await setLegacyStatus(studioA, 'cancelled', null);
    await seedEntitlement(studioA.id, 'active');
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'active');
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('14.1) cancelled entitlement with future paid-through overrides legacy cancelled', async () => {
    const fixedNow = new Date('2030-01-07T00:00:00.000Z');
    await setLegacyStatus(studioA, 'cancelled', null);
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: addDays(fixedNow, 2),
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: fixedNow,
    });

    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'cancelled');
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('14.2) cancelled entitlement without trustworthy paid-through overrides legacy active to deny', async () => {
    await setLegacyStatus(studioA, 'active', null);
    await seedEntitlement(studioA.id, 'cancelled', {
      currentPeriodEnd: null,
    });

    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      now: new Date('2030-01-08T00:00:00.000Z'),
    });

    assert.strictEqual(decision.decisionSource, 'entitlement');
    assert.strictEqual(decision.normalizedStatus, 'cancelled');
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('15) no entitlement + valid legacy trial -> operational', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'trial', addDays(new Date(), 3));
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.decisionSource, 'legacy_studio');
    assert.strictEqual(decision.subscriptionStatus, 'trial');
    assert.strictEqual(decision.trialExpired, false);
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('16) no entitlement + expired legacy trial -> denied', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'trial', addDays(new Date(), -3));
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.subscriptionStatus, 'trial');
    assert.strictEqual(decision.trialExpired, true);
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('17) no entitlement + legacy active -> operational', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'active', null);
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.operationalAccess, true);
  });

  await test('18) no entitlement + legacy past_due -> denied', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'past_due', null);
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('19) no entitlement + legacy suspended -> denied', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'suspended', null);
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('20) no entitlement + legacy cancelled -> denied', async () => {
    await clearEntitlements(studioB.id);
    await setLegacyStatus(studioB, 'cancelled', null);
    const decision = await resolveSubscriptionAccessDecision({ studioId: studioB.id });
    assert.strictEqual(decision.operationalAccess, false);
  });

  await test('21) missing studio lookup -> check unavailable', async () => {
    const decision = await resolveSubscriptionAccessDecision({ studioId: 999999 });
    assert.strictEqual(decision.ok, false);
    assert.strictEqual(decision.code, 'SUBSCRIPTION_CHECK_UNAVAILABLE');
  });

  await test('22) resolver internal failure -> unavailable', async () => {
    const decision = await resolveSubscriptionAccessDecision({
      studioId: studioA.id,
      dependencies: {
        EntitlementModel: {
          findOne: async () => {
            throw new Error('simulated entitlement query failure');
          },
        },
      },
    });

    assert.strictEqual(decision.ok, false);
    assert.strictEqual(decision.code, 'SUBSCRIPTION_CHECK_UNAVAILABLE');
  });

  await test('23) middleware maps ineffective subscription to 402', async () => {
    await seedEntitlement(studioA.id, 'expired');
    const { res, nextCalled } = await runMiddleware({
      user: { id: 1, studioId: studioA.id },
      authContext: { hasExplicitStudioContext: true, studioIdSource: 'token' },
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 402);
    assert.strictEqual(res.payload.error, 'SUBSCRIPTION_REQUIRED');
  });

  await test('24) 402 payload excludes sensitive identifiers', async () => {
    await seedEntitlement(studioA.id, 'expired');
    const { res } = await runMiddleware({
      user: { id: 1, studioId: studioA.id },
      authContext: { hasExplicitStudioContext: true, studioIdSource: 'token' },
    });

    assert.strictEqual(res.statusCode, 402);
    assert.deepStrictEqual(Object.keys(res.payload).sort(), [
      'code',
      'error',
      'normalizedStatus',
      'recoveryAllowed',
      'subscriptionStatus',
      'trialExpired',
    ]);

    const serialized = JSON.stringify(res.payload);
    const forbidden = [
      'studioId',
      'providerSubscriptionId',
      'transactionId',
      'purchaseToken',
      'appAccountToken',
      'entitlement',
    ];

    for (const key of forbidden) {
      assert.strictEqual(serialized.includes(key), false);
    }
  });

  await test('25) 503 payload excludes internal details', async () => {
    const { res } = await runMiddleware({
      user: { id: 1, studioId: 999999 },
      authContext: { hasExplicitStudioContext: true, studioIdSource: 'token' },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.payload, {
      error: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
      code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    });
  });

  await test('26) fallback-derived Studio 1 is refused for enforcement decision', async () => {
    const { res, nextCalled } = await runMiddleware({
      user: { id: 1, studioId: 1 },
      authContext: { hasExplicitStudioContext: false, studioIdSource: 'fallback_legacy_default' },
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.payload, {
      error: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
      code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    });
  });

  await test('27) explicit legitimate Studio 1 is evaluated normally', async () => {
    const studioOne = await Studio.findByPk(1);
    assert.ok(studioOne);
    await clearEntitlements(studioOne.id);
    await setLegacyStatus(studioOne, 'active', null);

    const { res, nextCalled } = await runMiddleware({
      user: { id: 1, studioId: 1 },
      authContext: { hasExplicitStudioContext: true, studioIdSource: 'token' },
    });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);
  });

  await test('28) no JWT payload contract change (buildAuthPayload shape)', async () => {
    const authTokenSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'authToken.js'), 'utf8');
    assert.ok(authTokenSource.includes('return {'));
    assert.ok(authTokenSource.includes('id: userLike.id'));
    assert.ok(authTokenSource.includes('role: userLike.role'));
    assert.ok(authTokenSource.includes('assignedSalonIds'));
    assert.ok(authTokenSource.includes('permissions'));
    assert.ok(authTokenSource.includes('studioId'));
  });

  await test('29) no login response contract change', async () => {
    const authRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.ok(authRouteSource.includes('res.json({'));
    assert.ok(authRouteSource.includes('token,'));
    assert.ok(authRouteSource.includes('role: payload.role'));
    assert.ok(authRouteSource.includes('assignedSalonIds: payload.assignedSalonIds'));
    assert.ok(authRouteSource.includes('permissions: payload.permissions'));
    assert.ok(authRouteSource.includes('studioId: payload.studioId'));
    assert.ok(authRouteSource.includes('studioCode: studio.studioCode'));
  });

  await test('30) no registration response contract change', async () => {
    const registerSource = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'registerController.js'), 'utf8');
    assert.ok(registerSource.includes('message: \'Studio registered successfully\''));
    assert.ok(registerSource.includes('token,'));
    assert.ok(registerSource.includes('user: {'));
    assert.ok(registerSource.includes('studio: {'));
  });

  await test('31) no route enforcement activated', async () => {
    const statusRoute = findRoute(subscriptionRoute, 'get', '/status');
    const catalogRoute = findRoute(subscriptionRoute, 'get', '/catalog');
    assert.ok(statusRoute);
    assert.ok(catalogRoute);

    const statusHandlers = statusRoute.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);
    const catalogHandlers = catalogRoute.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);
    assert.strictEqual(statusHandlers.includes('requireActiveSubscription'), false);
    assert.strictEqual(catalogHandlers.includes('requireActiveSubscription'), false);
  });

  await test('32) purchase and restore endpoints unchanged', async () => {
    const endpoints = [
      ['post', '/apple/purchase-intent'],
      ['post', '/google-play/purchase-intent'],
      ['post', '/apple/verify-purchase'],
      ['post', '/google-play/verify-purchase'],
      ['post', '/apple/restore'],
      ['post', '/google-play/restore'],
    ];

    for (const [method, routePath] of endpoints) {
      const route = findRoute(subscriptionRoute, method, routePath);
      assert.ok(route, `missing ${method.toUpperCase()} ${routePath}`);
      const handlers = route.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);
      assert.strictEqual(handlers.includes('requireActiveSubscription'), false);
    }
  });

  await test('33) subscription status/catalog endpoints unchanged', async () => {
    const statusRoute = findRoute(subscriptionRoute, 'get', '/status');
    const catalogRoute = findRoute(subscriptionRoute, 'get', '/catalog');

    assert.ok(statusRoute);
    assert.ok(catalogRoute);

    const statusHandlers = statusRoute.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);
    const catalogHandlers = catalogRoute.route.stack.map((layer) => layer.handle && layer.handle.name).filter(Boolean);

    assert.strictEqual(statusHandlers.includes('authenticateToken'), true);
    assert.strictEqual(catalogHandlers.includes('authenticateToken'), true);
  });

  await test('34) access checks perform no database mutation', async () => {
    await seedEntitlement(studioA.id, 'expired');

    const before = {
      entitlements: await StudioSubscriptionEntitlement.count(),
      intents: await SubscriptionPurchaseIntent.count(),
      appleTx: await AppleSubscriptionTransaction.count(),
      googleTx: await GooglePlaySubscriptionTransaction.count(),
    };

    const decision = await resolveSubscriptionAccessDecision({ studioId: studioA.id });
    assert.strictEqual(decision.ok, true);

    const result = await runMiddleware({
      user: { id: 1, studioId: studioA.id },
      authContext: { hasExplicitStudioContext: true, studioIdSource: 'token' },
    });
    assert.strictEqual(result.res.statusCode, 402);

    const after = {
      entitlements: await StudioSubscriptionEntitlement.count(),
      intents: await SubscriptionPurchaseIntent.count(),
      appleTx: await AppleSubscriptionTransaction.count(),
      googleTx: await GooglePlaySubscriptionTransaction.count(),
    };

    assert.deepStrictEqual(after, before);
  });

  await test('enforcement operational set excludes paused and includes grace_period/billing_retry', async () => {
    assert.strictEqual(ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES.includes('paused'), false);
    assert.strictEqual(ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES.includes('billing_retry'), true);
    assert.strictEqual(ENFORCEMENT_OPERATIONAL_NORMALIZED_STATUSES.includes('grace_period'), true);
  });

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
