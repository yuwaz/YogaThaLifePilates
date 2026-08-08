const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase320-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');

  process.env.DB_PATH = dbPath;

  const {
    createGooglePlayDeveloperClient,
    getGooglePlayDeveloperClient,
  } = require('../services/googlePlayDeveloperClient');
  const subscriptionController = require('../controllers/subscriptionController');
  const {
    verifyGooglePlayPurchaseForStudio,
    shouldApplyGooglePlayTransactionUpdate,
    shouldApplyGooglePlayEntitlementUpdate,
  } = require('../services/googlePlayPurchaseVerificationService');
  const { generateGoogleObfuscatedAccountId } = require('../services/googlePlaySubscriptionService');

  const {
    sequelize,
    Studio,
    User,
    SubscriptionPurchaseIntent,
    StudioSubscriptionEntitlement,
    GooglePlaySubscriptionTransaction,
    AppleSubscriptionTransaction,
    AppleServerNotificationInbox,
    GooglePubSubNotificationInbox,
  } = require('../models');

  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureGooglePlaySubscriptionTransactionsTable = require('../ensureGooglePlaySubscriptionTransactionsTable');
  const ensureGooglePubSubNotificationInboxTable = require('../ensureGooglePubSubNotificationInboxTable');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES: process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID,
    GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID,
    GOOGLE_PLAY_ENVIRONMENTS_ALLOWED: process.env.GOOGLE_PLAY_ENVIRONMENTS_ALLOWED,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    GOOGLE_PLAY_SERVICE_ACCOUNT_PATH: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH,
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

  function addMinutes(baseDate, minutes) {
    return new Date(baseDate.getTime() + minutes * 60 * 1000);
  }

  function makeGoogleResponse({
    purchaseToken,
    productId = 'basic_product',
    basePlanId = 'basic_monthly',
    offerId = 'basic_offer',
    subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE',
    expiryMinutes = 60,
    startMinutes = -5,
    linkedPurchaseToken = null,
    externalAccountId,
    testPurchase = false,
    acknowledgementState = 'ACKNOWLEDGEMENT_STATE_PENDING',
    autoRenewEnabled = true,
    freeTrial = false,
    etag = 'etag-1',
    regionCode = 'TR',
  }) {
    const now = new Date();
    return {
      etag,
      kind: 'androidpublisher#subscriptionPurchaseV2',
      regionCode,
      startTime: addMinutes(now, startMinutes).toISOString(),
      acknowledgementState,
      linkedPurchaseToken,
      externalAccountIdentifiers: externalAccountId === null
        ? {}
        : { obfuscatedExternalAccountId: externalAccountId },
      subscriptionState,
      testPurchase: testPurchase ? {} : undefined,
      lineItems: [
        {
          productId,
          expiryTime: addMinutes(now, expiryMinutes).toISOString(),
          latestSuccessfulOrderId: `GPA.${purchaseToken}`,
          autoRenewingPlan: { autoRenewEnabled },
          offerDetails: {
            basePlanId,
            offerId,
          },
          offerPhase: freeTrial ? { freeTrial: {} } : undefined,
        },
      ],
      canceledStateContext: subscriptionState === 'SUBSCRIPTION_STATE_CANCELED'
        ? { userInitiatedCancellation: {} }
        : undefined,
      inGracePeriodStateContext: subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
        ? { renewalDeclined: {} }
        : undefined,
      onHoldStateContext: subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD'
        ? { renewalDeclined: {} }
        : undefined,
      pausedStateContext: subscriptionState === 'SUBSCRIPTION_STATE_PAUSED'
        ? { autoResumeTime: addMinutes(now, 30).toISOString() }
        : undefined,
    };
  }

  function createFakeGoogleClient(responseOrError) {
    const calls = [];
    const client = {
      purchases: {
        subscriptionsv2: {
          get: async (params) => {
            calls.push(params);
            if (responseOrError instanceof Error) {
              throw responseOrError;
            }
            return { data: responseOrError };
          },
        },
      },
    };

    return { client, calls };
  }

  async function createStudioWithAdmin({ label, subscriptionStatus = 'trial', subscriptionPlan = 'trial', trialEndsAt = null }) {
    const counter = Date.now() + Math.floor(Math.random() * 100000);
    const studio = await Studio.create({
      name: `Studio ${label}`,
      studioCode: `code-${counter}`,
      email: null,
      phone: null,
      country: 'TR',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      subscriptionStatus,
      subscriptionPlan,
      trialEndsAt,
    });

    const user = await User.create({
      username: `user-${counter}`,
      password: 'x',
      role: 'admin',
      assignedSalonIds: [],
      permissions: [],
      studioId: studio.id,
    });

    return { studio, user };
  }

  async function createGoogleIntent(studioId, userId, targetPlan, status = 'created', extra = {}) {
    const expiresAt = addMinutes(new Date(), 60);
    return SubscriptionPurchaseIntent.create({
      studioId,
      provider: 'google_play',
      targetPlan,
      appAccountToken: null,
      googleObfuscatedAccountId: generateGoogleObfuscatedAccountId({ studioId, secret: 'phase320-secret-0123456789012345' }),
      googleObfuscatedProfileId: null,
      status,
      expiresAt,
      consumedAt: null,
      createdByUserId: userId || null,
      metadataJson: null,
      ...extra,
    });
  }

  function assertSafeVerifiedResponse(payload) {
    assert.ok(payload && typeof payload === 'object');
    assert.ok(payload.verifiedPurchase && typeof payload.verifiedPurchase === 'object');
    const keys = Object.keys(payload.verifiedPurchase).sort();
    assert.deepStrictEqual(keys, ['autoRenewEnabled', 'currentPeriodEnd', 'environment', 'plan', 'provider', 'status', 'trialEndsAt']);
  }

  await bootstrap();
  await bootstrap();

  const [tablesResult] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tablesResult.map((row) => row.name));

  await test('route exposes authenticated verification endpoint', async () => {
    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
    assert.ok(routeSource.includes("/google-play/verify-purchase"));
    assert.ok(routeSource.includes('authenticateToken'));
  });

  await test('endpoint requires authentication context', async () => {
    const req = { body: { purchaseIntentId: 1, purchaseToken: 'token' } };
    const res = makeRes();
    await subscriptionController.verifyGooglePlayPurchase(req, res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('purchase verification request validation rejects malformed bodies', async () => {
    const invalidBodies = [
      {},
      { purchaseToken: 'token' },
      { purchaseIntentId: 0, purchaseToken: 'token' },
      { purchaseIntentId: -1, purchaseToken: 'token' },
      { purchaseIntentId: 1, purchaseToken: '' },
      { purchaseIntentId: 1, purchaseToken: '   ' },
      { purchaseIntentId: 1, purchaseToken: null },
      { purchaseIntentId: 1, purchaseToken: 3 },
      { purchaseIntentId: 1, purchaseToken: 'x'.repeat(1025) },
    ];

    for (const body of invalidBodies) {
      const res = makeRes();
      await subscriptionController.verifyGooglePlayPurchase({ user: { studioId: 1, id: 1 }, body }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.payload, { error: 'INVALID_PURCHASE_VERIFICATION_REQUEST' });
    }
  });

  await test('another studio purchase intent is hidden as missing', async () => {
    const a = await createStudioWithAdmin({ label: 'a' });
    const b = await createStudioWithAdmin({ label: 'b' });
    const intent = await createGoogleIntent(a.studio.id, a.user.id, 'basic');

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-1',
      externalAccountId: intent.googleObfuscatedAccountId,
    }));

    let caught;
    try {
      await verifyGooglePlayPurchaseForStudio({
        studioId: b.studio.id,
        userId: b.user.id,
        purchaseIntentId: intent.id,
        purchaseToken: 'purchase-1',
        now: new Date(),
        dependencies: {
          googleClient: fake.client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            basicOfferId: 'basic_offer',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught);
    assert.strictEqual(caught.code, 'GOOGLE_PLAY_PURCHASE_INTENT_NOT_FOUND');
    assert.strictEqual(fake.calls.length, 0);
  });

  await test('created and started intents verify successfully and consume intent', async () => {
    const createdStudio = await createStudioWithAdmin({ label: 'success-created' });
    const startedStudio = await createStudioWithAdmin({ label: 'success-started' });
    const createdIntent = await createGoogleIntent(createdStudio.studio.id, createdStudio.user.id, 'basic', 'created');
    const startedIntent = await createGoogleIntent(startedStudio.studio.id, startedStudio.user.id, 'pro', 'started');

    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.example.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID = 'basic_offer';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PLAY_ENVIRONMENTS_ALLOWED = 'production,test';

    const createdResponse = makeGoogleResponse({
      purchaseToken: 'purchase-1',
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: 'basic_offer',
      externalAccountId: createdIntent.googleObfuscatedAccountId,
      subscriptionState: 'SUBSCRIPTION_STATE_PENDING',
    });

    const startedResponse = makeGoogleResponse({
      purchaseToken: 'purchase-2',
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      offerId: null,
      externalAccountId: startedIntent.googleObfuscatedAccountId,
      testPurchase: true,
      freeTrial: true,
    });

    const fakeCreated = createFakeGoogleClient(createdResponse);
    const resultCreated = await verifyGooglePlayPurchaseForStudio({
      studioId: createdStudio.studio.id,
      userId: createdStudio.user.id,
      purchaseIntentId: createdIntent.id,
      purchaseToken: 'purchase-1',
      now: new Date(),
      dependencies: {
        googleClient: fakeCreated.client,
        googlePlayProductConfiguration: {
          packageName: 'com.example.app',
          basicProductId: 'basic_product',
          basicBasePlanId: 'basic_monthly',
          basicOfferId: 'basic_offer',
          proProductId: 'pro_product',
          proBasePlanId: 'pro_monthly',
        },
        allowedEnvironments: new Set(['production', 'test']),
      },
    });

    assertSafeVerifiedResponse(resultCreated);
    assert.strictEqual(resultCreated.verifiedPurchase.provider, 'google_play');
    assert.strictEqual(resultCreated.verifiedPurchase.plan, 'basic');
    assert.strictEqual(resultCreated.verifiedPurchase.environment, 'production');
    assert.strictEqual(fakeCreated.calls.length, 1);
    assert.deepStrictEqual(fakeCreated.calls[0], { packageName: 'com.example.app', token: 'purchase-1' });

    const fakeStarted = createFakeGoogleClient(startedResponse);
    const resultStarted = await verifyGooglePlayPurchaseForStudio({
      studioId: startedStudio.studio.id,
      userId: startedStudio.user.id,
      purchaseIntentId: startedIntent.id,
      purchaseToken: 'purchase-2',
      now: new Date(),
      dependencies: {
        googleClient: fakeStarted.client,
        googlePlayProductConfiguration: {
          packageName: 'com.example.app',
          basicProductId: 'basic_product',
          basicBasePlanId: 'basic_monthly',
          basicOfferId: 'basic_offer',
          proProductId: 'pro_product',
          proBasePlanId: 'pro_monthly',
        },
        allowedEnvironments: new Set(['production', 'test']),
      },
    });

    assertSafeVerifiedResponse(resultStarted);
    assert.strictEqual(resultStarted.verifiedPurchase.plan, 'pro');
    assert.strictEqual(resultStarted.verifiedPurchase.status, 'trialing');
    assert.strictEqual(resultStarted.verifiedPurchase.environment, 'test');

    const createdRow = await SubscriptionPurchaseIntent.findByPk(createdIntent.id);
    const startedRow = await SubscriptionPurchaseIntent.findByPk(startedIntent.id);
    assert.strictEqual(createdRow.status, 'consumed');
    assert.ok(createdRow.consumedAt);
    assert.strictEqual(startedRow.status, 'consumed');
    assert.ok(startedRow.consumedAt);

    const transactionCount = await GooglePlaySubscriptionTransaction.count({ where: { studioId: createdStudio.studio.id } });
    const entitlementCount = await StudioSubscriptionEntitlement.count({ where: { studioId: createdStudio.studio.id, provider: 'google_play' } });
    assert.strictEqual(transactionCount, 1);
    assert.strictEqual(entitlementCount, 1);
  });

  await test('invalid intent states are rejected', async () => {
    const studio = await createStudioWithAdmin({ label: 'invalid-states' });
    const response = makeGoogleResponse({
      purchaseToken: 'purchase-invalid',
      externalAccountId: generateGoogleObfuscatedAccountId({ studioId: studio.studio.id, secret: 'phase320-secret-0123456789012345' }),
    });
    const fake = createFakeGoogleClient(response);

    const invalidStatuses = [
      ['verified', 'GOOGLE_PLAY_PURCHASE_INTENT_INVALID'],
      ['cancelled', 'GOOGLE_PLAY_PURCHASE_INTENT_INVALID'],
      ['failed', 'GOOGLE_PLAY_PURCHASE_INTENT_INVALID'],
      ['expired', 'GOOGLE_PLAY_PURCHASE_INTENT_EXPIRED'],
      ['consumed', 'GOOGLE_PLAY_PURCHASE_INTENT_ALREADY_CONSUMED'],
    ];

    for (const [status, code] of invalidStatuses) {
      const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic', status);
      await assert.rejects(
        verifyGooglePlayPurchaseForStudio({
          studioId: studio.studio.id,
          userId: studio.user.id,
          purchaseIntentId: intent.id,
          purchaseToken: 'purchase-invalid',
          now: new Date(),
          dependencies: {
            googleClient: fake.client,
            googlePlayProductConfiguration: {
              packageName: 'com.example.app',
              basicProductId: 'basic_product',
              basicBasePlanId: 'basic_monthly',
              basicOfferId: 'basic_offer',
              proProductId: 'pro_product',
              proBasePlanId: 'pro_monthly',
            },
            allowedEnvironments: new Set(['production']),
          },
        }),
        (error) => error.code === code
      );
    }
  });

  await test('account identifier mismatch and missing identifier are rejected', async () => {
    const mismatchStudio = await createStudioWithAdmin({ label: 'account-id-mismatch' });
    const mismatchIntent = await createGoogleIntent(mismatchStudio.studio.id, mismatchStudio.user.id, 'basic');
    const mismatch = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-account',
      externalAccountId: 'f'.repeat(64),
    }));
    let error = null;
    try {
      await verifyGooglePlayPurchaseForStudio({
        studioId: mismatchStudio.studio.id,
        userId: mismatchStudio.user.id,
        purchaseIntentId: mismatchIntent.id,
        purchaseToken: 'purchase-account',
        now: new Date(),
        dependencies: {
          googleClient: mismatch.client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      });
    } catch (caughtError) {
      error = caughtError;
    }
    assert.ok(error);
    assert.strictEqual(error.code, 'GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISMATCH');

    const missingStudio = await createStudioWithAdmin({ label: 'account-id-missing' });
    const missingIntent = await createGoogleIntent(missingStudio.studio.id, missingStudio.user.id, 'basic');
    const missing = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-account-2',
      externalAccountId: null,
    }));
    error = null;
    try {
      await verifyGooglePlayPurchaseForStudio({
        studioId: missingStudio.studio.id,
        userId: missingStudio.user.id,
        purchaseIntentId: missingIntent.id,
        purchaseToken: 'purchase-account-2',
        now: new Date(),
        dependencies: {
          googleClient: missing.client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      });
    } catch (caughtError) {
      error = caughtError;
    }
    assert.ok(error);
    assert.strictEqual(error.code, 'GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISSING');
  });

  await test('plan mapping validates product, base plan, and offer', async () => {
    const studio = await createStudioWithAdmin({ label: 'plan-mapping' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const bad = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-plan',
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      externalAccountId: intent.googleObfuscatedAccountId,
    }));

    await assert.rejects(
      verifyGooglePlayPurchaseForStudio({
        studioId: studio.studio.id,
        userId: studio.user.id,
        purchaseIntentId: intent.id,
        purchaseToken: 'purchase-plan',
        now: new Date(),
        dependencies: {
          googleClient: bad.client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            basicOfferId: 'basic_offer',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      }),
      (error) => error.code === 'GOOGLE_PLAY_PURCHASE_PLAN_MISMATCH'
    );
  });

  await test('environment allowlist is enforced and test purchases are explicit', async () => {
    const studio = await createStudioWithAdmin({ label: 'env-allow' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const testResponse = makeGoogleResponse({
      purchaseToken: 'purchase-test-env',
      externalAccountId: intent.googleObfuscatedAccountId,
      testPurchase: true,
    });

    await assert.rejects(
      verifyGooglePlayPurchaseForStudio({
        studioId: studio.studio.id,
        userId: studio.user.id,
        purchaseIntentId: intent.id,
        purchaseToken: 'purchase-test-env',
        now: new Date(),
        dependencies: {
          googleClient: createFakeGoogleClient(testResponse).client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            basicOfferId: 'basic_offer',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      }),
      (error) => error.code === 'GOOGLE_PLAY_ENVIRONMENT_NOT_ALLOWED'
    );
  });

  await test('google api errors are classified without leaking raw details', async () => {
    const studio = await createStudioWithAdmin({ label: 'google-errors' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const baseArgs = {
      studioId: studio.studio.id,
      userId: studio.user.id,
      purchaseIntentId: intent.id,
      purchaseToken: 'purchase-error',
      now: new Date(),
      dependencies: {
        googlePlayProductConfiguration: {
          packageName: 'com.example.app',
          basicProductId: 'basic_product',
          basicBasePlanId: 'basic_monthly',
          proProductId: 'pro_product',
          proBasePlanId: 'pro_monthly',
        },
        allowedEnvironments: new Set(['production']),
      },
    };

    const scenarios = [
      {
        error: Object.assign(new Error('missing required authentication credential'), {
          response: { status: 401, data: { error: { status: 'UNAUTHENTICATED', errors: [{ reason: 'CREDENTIALS_MISSING' }] } } },
        }),
        code: 'GOOGLE_PLAY_CONFIGURATION_FAILED',
      },
      {
        error: Object.assign(new Error('permission denied'), {
          response: { status: 403, data: { error: { status: 'PERMISSION_DENIED' } } },
        }),
        code: 'GOOGLE_PLAY_PERMISSION_FAILED',
      },
      {
        error: Object.assign(new Error('too many requests'), {
          response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
        }),
        code: 'GOOGLE_PLAY_RATE_LIMITED',
      },
      {
        error: Object.assign(new Error('server unavailable'), {
          response: { status: 503, data: { error: { status: 'UNAVAILABLE' } } },
        }),
        code: 'GOOGLE_PLAY_TEMPORARILY_UNAVAILABLE',
      },
    ];

    for (const scenario of scenarios) {
      await assert.rejects(
        verifyGooglePlayPurchaseForStudio({
          ...baseArgs,
          dependencies: {
            ...baseArgs.dependencies,
            googleClient: createFakeGoogleClient(scenario.error).client,
          },
        }),
        (error) => error.code === scenario.code
      );
    }
  });

  await test('successful verification persists transaction, entitlement, and consumes intent', async () => {
    const studio = await createStudioWithAdmin({ label: 'persist' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const response = makeGoogleResponse({
      purchaseToken: 'purchase-persist',
      externalAccountId: intent.googleObfuscatedAccountId,
      testPurchase: false,
      freeTrial: false,
    });
    const fake = createFakeGoogleClient(response);

    const result = await verifyGooglePlayPurchaseForStudio({
      studioId: studio.studio.id,
      userId: studio.user.id,
      purchaseIntentId: intent.id,
      purchaseToken: 'purchase-persist',
      now: new Date(),
      dependencies: {
        googleClient: fake.client,
        googlePlayProductConfiguration: {
          packageName: 'com.example.app',
          basicProductId: 'basic_product',
          basicBasePlanId: 'basic_monthly',
          basicOfferId: 'basic_offer',
          proProductId: 'pro_product',
          proBasePlanId: 'pro_monthly',
        },
        allowedEnvironments: new Set(['production', 'test']),
      },
    });

    assertSafeVerifiedResponse(result);

    const transaction = await GooglePlaySubscriptionTransaction.findOne({ where: { studioId: studio.studio.id, purchaseToken: 'purchase-persist', environment: 'production' } });
    const entitlement = await StudioSubscriptionEntitlement.findOne({ where: { studioId: studio.studio.id, provider: 'google_play', providerSubscriptionId: 'purchase-persist', environment: 'production' } });
    const consumedIntent = await SubscriptionPurchaseIntent.findByPk(intent.id);

    assert.ok(transaction);
    assert.ok(entitlement);
    assert.ok(consumedIntent);
    assert.strictEqual(transaction.packageName, 'com.example.app');
    assert.strictEqual(transaction.productId, 'basic_product');
    assert.strictEqual(transaction.basePlanId, 'basic_monthly');
    assert.strictEqual(transaction.purchaseToken, 'purchase-persist');
    assert.strictEqual(transaction.studioId, studio.studio.id);
    assert.strictEqual(entitlement.provider, 'google_play');
    assert.strictEqual(entitlement.plan, 'basic');
    assert.strictEqual(entitlement.normalizedStatus, 'active');
    assert.strictEqual(consumedIntent.status, 'consumed');
    assert.ok(consumedIntent.consumedAt);

    const beforeStudio = await Studio.findByPk(studio.studio.id);
    assert.strictEqual(beforeStudio.subscriptionStatus, 'trial');
    assert.strictEqual(fake.calls.length, 1);
  });

  await test('same purchaseToken is idempotent on retry', async () => {
    const studio = await createStudioWithAdmin({ label: 'idempotent' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const response = makeGoogleResponse({
      purchaseToken: 'purchase-idempotent',
      externalAccountId: intent.googleObfuscatedAccountId,
    });
    const fake = createFakeGoogleClient(response);
    const dependencies = {
      googleClient: fake.client,
      googlePlayProductConfiguration: {
        packageName: 'com.example.app',
        basicProductId: 'basic_product',
        basicBasePlanId: 'basic_monthly',
        basicOfferId: 'basic_offer',
        proProductId: 'pro_product',
        proBasePlanId: 'pro_monthly',
      },
      allowedEnvironments: new Set(['production']),
    };

    const first = await verifyGooglePlayPurchaseForStudio({
      studioId: studio.studio.id,
      userId: studio.user.id,
      purchaseIntentId: intent.id,
      purchaseToken: 'purchase-idempotent',
      now: new Date(),
      dependencies,
    });
    const second = await verifyGooglePlayPurchaseForStudio({
      studioId: studio.studio.id,
      userId: studio.user.id,
      purchaseIntentId: intent.id,
      purchaseToken: 'purchase-idempotent',
      now: new Date(),
      dependencies,
    });

    assertSafeVerifiedResponse(first);
    assertSafeVerifiedResponse(second);
    assert.strictEqual(await GooglePlaySubscriptionTransaction.count({ where: { studioId: studio.studio.id, purchaseToken: 'purchase-idempotent', environment: 'production' } }), 1);
    assert.strictEqual(await StudioSubscriptionEntitlement.count({ where: { studioId: studio.studio.id, provider: 'google_play', providerSubscriptionId: 'purchase-idempotent', environment: 'production' } }), 1);
  });

  await test('effective Apple entitlement blocks Google activation', async () => {
    const studio = await createStudioWithAdmin({ label: 'apple-block' });
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    await StudioSubscriptionEntitlement.create({
      studioId: studio.studio.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'apple-basic',
      providerSubscriptionId: 'apple-sub-1',
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 60),
      lastVerifiedAt: new Date(),
      autoRenewEnabled: true,
    });

    await assert.rejects(
      verifyGooglePlayPurchaseForStudio({
        studioId: studio.studio.id,
        userId: studio.user.id,
        purchaseIntentId: intent.id,
        purchaseToken: 'purchase-apple-block',
        now: new Date(),
        dependencies: {
          googleClient: createFakeGoogleClient(makeGoogleResponse({
            purchaseToken: 'purchase-apple-block',
            externalAccountId: intent.googleObfuscatedAccountId,
          })).client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      }),
      (error) => error.code === 'OTHER_PROVIDER_ENTITLEMENT_ACTIVE'
    );
  });

  await test('linked purchase replacement can retire same-studio effective Google entitlement', async () => {
    const studio = await createStudioWithAdmin({ label: 'replacement' });
    const oldToken = 'purchase-old';
    const newToken = 'purchase-new';
    const newIntent = await createGoogleIntent(studio.studio.id, studio.user.id, 'pro');

    await StudioSubscriptionEntitlement.create({
      studioId: studio.studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'basic_product',
      providerSubscriptionId: oldToken,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 30),
      autoRenewEnabled: true,
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      lastVerifiedAt: new Date(),
    });

    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.studio.id,
      environment: 'production',
      packageName: 'com.example.app',
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: 'basic_offer',
      purchaseToken: oldToken,
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: 'GPA.old',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: addMinutes(new Date(), 30),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: generateGoogleObfuscatedAccountId({ studioId: studio.studio.id, secret: 'phase320-secret-0123456789012345' }),
      rawApiResponseJson: JSON.stringify({}),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: newToken,
      linkedPurchaseToken: oldToken,
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      externalAccountId: newIntent.googleObfuscatedAccountId,
    }));

    let result = null;
    let error = null;
    try {
      result = await verifyGooglePlayPurchaseForStudio({
        studioId: studio.studio.id,
        userId: studio.user.id,
        purchaseIntentId: newIntent.id,
        purchaseToken: newToken,
        now: new Date(),
        dependencies: {
          googleClient: fake.client,
          googlePlayProductConfiguration: {
            packageName: 'com.example.app',
            basicProductId: 'basic_product',
            basicBasePlanId: 'basic_monthly',
            basicOfferId: 'basic_offer',
            proProductId: 'pro_product',
            proBasePlanId: 'pro_monthly',
          },
          allowedEnvironments: new Set(['production']),
        },
      });
    } catch (caughtError) {
      error = caughtError;
    }

    assert.strictEqual(error, null);
    assertSafeVerifiedResponse(result);
    const oldEntitlement = await StudioSubscriptionEntitlement.findOne({ where: { studioId: studio.studio.id, provider: 'google_play', providerSubscriptionId: oldToken, environment: 'production' } });
    const newEntitlement = await StudioSubscriptionEntitlement.findOne({ where: { studioId: studio.studio.id, provider: 'google_play', providerSubscriptionId: newToken, environment: 'production' } });
    assert.strictEqual(oldEntitlement.normalizedStatus === 'cancelled' || oldEntitlement.normalizedStatus === 'expired', true);
    assert.strictEqual(newEntitlement.normalizedStatus, 'active');
  });

  await test('stale update helpers preserve newer snapshots', async () => {
    const base = {
      providerEventTime: new Date('2026-01-01T00:00:00.000Z'),
      expiryTime: new Date('2026-01-01T01:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ingestedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const older = {
      providerEventTime: new Date('2025-12-31T23:00:00.000Z'),
      expiryTime: new Date('2026-01-01T00:30:00.000Z'),
      ingestedAt: new Date('2025-12-31T23:00:00.000Z'),
    };
    const newer = {
      providerEventTime: new Date('2026-01-01T02:00:00.000Z'),
      expiryTime: new Date('2026-01-01T03:00:00.000Z'),
      ingestedAt: new Date('2026-01-01T02:00:00.000Z'),
    };

    assert.strictEqual(shouldApplyGooglePlayTransactionUpdate(base, older), false);
    assert.strictEqual(shouldApplyGooglePlayTransactionUpdate(base, newer), true);
    assert.strictEqual(shouldApplyGooglePlayEntitlementUpdate(base, older), false);
    assert.strictEqual(shouldApplyGooglePlayEntitlementUpdate(base, newer), true);
  });

  await test('real adapter exposes subscriptionsv2.get and lazy client construction works', async () => {
    const androidpublisher = google.androidpublisher({ version: 'v3' });
    assert.strictEqual(typeof androidpublisher.purchases.subscriptionsv2.get, 'function');
    assert.strictEqual(androidpublisher.purchases.subscriptionsv2.get.length, 3);

    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.example.app';
    await assert.rejects(
      Promise.resolve().then(() => getGooglePlayDeveloperClient()),
      (error) => error && error.code === 'GOOGLE_PLAY_SERVICE_ACCOUNT_REQUIRED'
    );

    const fakeGoogle = {
      auth: {
        GoogleAuth: class {
          constructor(options) {
            this.options = options;
          }
        },
      },
      androidpublisher: ({ version, auth }) => {
        assert.strictEqual(version, 'v3');
        assert.ok(auth);
        return {
          purchases: {
            subscriptionsv2: {
              get: () => { throw new Error('should not call'); },
            },
          },
        };
      },
    };

    const created = createGooglePlayDeveloperClient({
      config: {
        packageName: 'com.example.app',
        serviceAccountJson: JSON.stringify({
          client_email: 'svc@example.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
          project_id: 'my-project',
        }),
      },
    }, {
      google: fakeGoogle,
      GoogleAuthCtor: fakeGoogle.auth.GoogleAuth,
      androidPublisherFactory: fakeGoogle.androidpublisher,
    });

    assert.strictEqual(created.config.packageName, 'com.example.app');
    assert.strictEqual(created.scope.includes('androidpublisher'), true);
  });

  await test('no Studio subscription mirrors change during verification', async () => {
    const studio = await createStudioWithAdmin({ label: 'mirror-check' });
    const before = await Studio.findByPk(studio.studio.id);
    const intent = await createGoogleIntent(studio.studio.id, studio.user.id, 'basic');
    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-mirror',
      externalAccountId: intent.googleObfuscatedAccountId,
    }));

    await verifyGooglePlayPurchaseForStudio({
      studioId: studio.studio.id,
      userId: studio.user.id,
      purchaseIntentId: intent.id,
      purchaseToken: 'purchase-mirror',
      now: new Date(),
      dependencies: {
        googleClient: fake.client,
        googlePlayProductConfiguration: {
          packageName: 'com.example.app',
          basicProductId: 'basic_product',
          basicBasePlanId: 'basic_monthly',
          proProductId: 'pro_product',
          proBasePlanId: 'pro_monthly',
        },
        allowedEnvironments: new Set(['production']),
      },
    });

    const after = await Studio.findByPk(studio.studio.id);
    assert.strictEqual(after.subscriptionStatus, before.subscriptionStatus);
    assert.strictEqual(after.subscriptionPlan, before.subscriptionPlan);
    assert.strictEqual(after.trialEndsAt ? after.trialEndsAt.toISOString() : null, before.trialEndsAt ? before.trialEndsAt.toISOString() : null);
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
