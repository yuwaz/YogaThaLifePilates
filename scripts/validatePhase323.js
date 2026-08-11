const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase323-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    SubscriptionPurchaseIntent,
  } = require('../models');

  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureGooglePlaySubscriptionTransactionsTable = require('../ensureGooglePlaySubscriptionTransactionsTable');
  const ensureGooglePubSubNotificationInboxTable = require('../ensureGooglePubSubNotificationInboxTable');

  const subscriptionRoute = require('../routes/subscription');
  const subscriptionController = require('../controllers/subscriptionController');
  const {
    PROVIDER_BACKED_SUBSCRIPTION_PLANS,
  } = require('../models/subscriptionInfrastructureMetadata');
  const {
    getAppleProductConfiguration,
    validateAppleProductConfiguration,
  } = require('../models/appleSubscriptionMetadata');
  const {
    getGooglePlayProductConfiguration,
    validateGooglePlayProductConfiguration,
  } = require('../models/googlePlaySubscriptionMetadata');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC: process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC,
    APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO: process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID,
    GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID,
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
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

    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.yogatha.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID = 'basic_offer';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID = 'pro_offer';

    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'phase323-secret-phase323-secret-123456';
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

  function findRoute(router, method, pathValue) {
    const stack = Array.isArray(router && router.stack) ? router.stack : [];
    return stack.find((layer) => {
      if (!layer || !layer.route) {
        return false;
      }

      const routePath = layer.route.path;
      const hasMethod = Boolean(layer.route.methods && layer.route.methods[method]);
      return hasMethod && routePath === pathValue;
    }) || null;
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
      trialEndsAt: null,
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

  await bootstrap();

  await test('A: authenticated catalog returns supported configured plans', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-auth');
    const req = {
      user: { id: user.id, studioId: studio.id },
      query: {},
      body: {},
      headers: {},
    };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.payload && Array.isArray(res.payload.plans));
    assert.strictEqual(res.payload.plans.length, PROVIDER_BACKED_SUBSCRIPTION_PLANS.length);
    assert.deepStrictEqual(res.payload.plans.map((p) => p.plan), PROVIDER_BACKED_SUBSCRIPTION_PLANS);
  });

  await test('B: Apple catalog IDs match verification mapping source', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-apple');
    const req = { user: { id: user.id, studioId: studio.id } };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);
    assert.strictEqual(res.statusCode, 200);

    const appleValidation = validateAppleProductConfiguration(getAppleProductConfiguration(), {
      requireConfigured: true,
    });
    assert.strictEqual(appleValidation.isValid, true);

    const byPlan = new Map(res.payload.plans.map((entry) => [entry.plan, entry]));
    assert.deepStrictEqual(byPlan.get('basic').apple.productIds, appleValidation.normalized.basicProductIds);
    assert.deepStrictEqual(byPlan.get('pro').apple.productIds, appleValidation.normalized.proProductIds);
  });

  await test('C: Google catalog identifiers match verification mapping source', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-google');
    const req = { user: { id: user.id, studioId: studio.id } };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);
    assert.strictEqual(res.statusCode, 200);

    const googleValidation = validateGooglePlayProductConfiguration(getGooglePlayProductConfiguration(), {
      requireConfigured: true,
    });
    assert.strictEqual(googleValidation.isValid, true);

    const byPlan = new Map(res.payload.plans.map((entry) => [entry.plan, entry]));

    assert.strictEqual(byPlan.get('basic').googlePlay.productId, googleValidation.normalized.basic.productId);
    assert.strictEqual(byPlan.get('basic').googlePlay.basePlanId, googleValidation.normalized.basic.basePlanId);
    assert.strictEqual(byPlan.get('basic').googlePlay.offerId, googleValidation.normalized.basic.offerId);

    assert.strictEqual(byPlan.get('pro').googlePlay.productId, googleValidation.normalized.pro.productId);
    assert.strictEqual(byPlan.get('pro').googlePlay.basePlanId, googleValidation.normalized.pro.basePlanId);
    assert.strictEqual(byPlan.get('pro').googlePlay.offerId, googleValidation.normalized.pro.offerId);
  });

  await test('D: catalog does not expose secret values', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-secrets');
    const req = { user: { id: user.id, studioId: studio.id } };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);
    assert.strictEqual(res.statusCode, 200);

    const serialized = JSON.stringify(res.payload);
    const forbiddenSnippets = [
      'GOOGLE_PLAY_ACCOUNT_HASH_SECRET',
      process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
      'appAccountToken',
      'obfuscatedAccountId',
      'purchaseToken',
      'transactionId',
      'privateKey',
      'serviceAccount',
      'issuerId',
      'webhook',
    ];

    for (const snippet of forbiddenSnippets) {
      assert.strictEqual(serialized.includes(snippet), false);
    }
  });

  await test('E: unsupported plans are not exposed as purchasable', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-plans');
    const req = { user: { id: user.id, studioId: studio.id } };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);
    assert.strictEqual(res.statusCode, 200);

    const returnedPlans = new Set(res.payload.plans.map((entry) => entry.plan));
    assert.strictEqual(returnedPlans.has('trial'), false);
    assert.strictEqual(returnedPlans.has('enterprise'), false);
    assert.strictEqual(returnedPlans.has('lifetime'), false);
    assert.strictEqual(returnedPlans.has('unknown'), false);
  });

  await test('F: Apple purchase-intent contract remains unchanged', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('apple-intent');
    const req = {
      user: { id: user.id, studioId: studio.id },
      body: { plan: 'basic' },
    };
    const res = makeRes();

    await subscriptionController.createApplePurchaseIntent(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.payload && res.payload.purchaseIntent);

    const keys = Object.keys(res.payload.purchaseIntent).sort();
    assert.deepStrictEqual(keys, ['appAccountToken', 'expiresAt', 'id', 'plan', 'provider']);
    assert.strictEqual(res.payload.purchaseIntent.provider, 'apple');
    assert.strictEqual(res.payload.purchaseIntent.plan, 'basic');
  });

  await test('G: Google purchase-intent contract remains unchanged', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('google-intent');
    const req = {
      user: { id: user.id, studioId: studio.id },
      body: { plan: 'pro' },
    };
    const res = makeRes();

    await subscriptionController.createGooglePlayPurchaseIntent(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.payload && res.payload.purchaseIntent);

    const keys = Object.keys(res.payload.purchaseIntent).sort();
    assert.deepStrictEqual(keys, ['expiresAt', 'id', 'obfuscatedAccountId', 'plan', 'provider']);
    assert.strictEqual(res.payload.purchaseIntent.provider, 'google_play');
    assert.strictEqual(res.payload.purchaseIntent.plan, 'pro');
  });

  await test('H: Apple verify contract remains unchanged for invalid request', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('apple-verify-contract');
    const req = {
      user: { id: user.id, studioId: studio.id },
      body: { signedTransactionInfo: 'x.y.z' },
    };
    const res = makeRes();

    await subscriptionController.verifyApplePurchase(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.payload, { error: 'INVALID_PURCHASE_VERIFICATION_REQUEST' });
  });

  await test('I: Google verify contract remains unchanged for invalid request', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('google-verify-contract');
    const req = {
      user: { id: user.id, studioId: studio.id },
      body: { purchaseToken: 'tok' },
    };
    const res = makeRes();

    await subscriptionController.verifyGooglePlayPurchase(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.payload, { error: 'INVALID_PURCHASE_VERIFICATION_REQUEST' });
  });

  await test('J: subscription enforcement middleware remains inactive', async () => {
    const appJsPath = path.join(__dirname, '..', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.strictEqual(appJs.includes('requireActiveSubscription'), false);

    const catalogRoute = findRoute(subscriptionRoute, 'get', '/catalog');
    assert.ok(catalogRoute, 'Expected GET /catalog route to exist');

    const layerNames = catalogRoute.route.stack.map((layer) => layer && layer.handle && layer.handle.name).filter(Boolean);
    assert.strictEqual(layerNames.includes('requireActiveSubscription'), false);
  });

  await test('K: catalog ignores studio selector injection attempts', async () => {
    configureCatalogEnv();

    const first = await createStudioWithUser('selector-first');
    const second = await createStudioWithUser('selector-second');

    const normalReq = {
      user: { id: first.user.id, studioId: first.studio.id },
      query: {},
      body: {},
      headers: {},
    };
    const injectedReq = {
      user: { id: first.user.id, studioId: first.studio.id },
      query: { studioId: second.studio.id },
      body: { studioId: second.studio.id },
      headers: { 'x-studio-id': String(second.studio.id) },
    };

    const normalRes = makeRes();
    const injectedRes = makeRes();

    await subscriptionController.getCatalog(normalReq, normalRes);
    await subscriptionController.getCatalog(injectedReq, injectedRes);

    assert.strictEqual(normalRes.statusCode, 200);
    assert.strictEqual(injectedRes.statusCode, 200);
    assert.deepStrictEqual(injectedRes.payload, normalRes.payload);
  });

  await test('catalog endpoint rejects requests without valid auth context', async () => {
    configureCatalogEnv();

    const res = makeRes();
    await subscriptionController.getCatalog({ user: { studioId: null } }, res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('catalog route uses authenticateToken middleware', async () => {
    const catalogRoute = findRoute(subscriptionRoute, 'get', '/catalog');
    assert.ok(catalogRoute);

    const handlers = catalogRoute.route.stack
      .map((layer) => layer && layer.handle && layer.handle.name)
      .filter(Boolean);

    assert.strictEqual(handlers[0], 'authenticateToken');
    assert.strictEqual(handlers[handlers.length - 1], 'getCatalog');
  });

  await test('catalog returns safe error when configuration is incomplete', async () => {
    delete process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC;
    delete process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO;
    configureCatalogEnv();
    delete process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO;

    const { studio, user } = await createStudioWithUser('catalog-incomplete');
    const req = { user: { id: user.id, studioId: studio.id } };
    const res = makeRes();

    await subscriptionController.getCatalog(req, res);

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.payload, {
      error: 'SUBSCRIPTION_CATALOG_CONFIGURATION_INCOMPLETE',
    });
  });

  await test('catalog endpoint does not mutate purchase-intent records', async () => {
    configureCatalogEnv();

    const { studio, user } = await createStudioWithUser('catalog-side-effects');

    const before = await SubscriptionPurchaseIntent.count();
    const res = makeRes();
    await subscriptionController.getCatalog({ user: { id: user.id, studioId: studio.id } }, res);
    const after = await SubscriptionPurchaseIntent.count();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(after, before);
  });

  report.summary = {
    passed: report.testsPassed.length,
    failed: report.testsFailed.length,
  };

  console.log(JSON.stringify(report, null, 2));

  await sequelize.close();
  process.exit(report.testsFailed.length > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
