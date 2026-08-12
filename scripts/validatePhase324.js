const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase324-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    SubscriptionPurchaseIntent,
    StudioSubscriptionEntitlement,
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

  const subscriptionController = require('../controllers/subscriptionController');
  const subscriptionRoutes = require('../routes/subscription');
  const {
    restoreAppleSubscriptionForStudio,
    AppleRestoreError,
  } = require('../services/appleRestoreService');
  const {
    restoreGooglePlaySubscriptionForStudio,
    GooglePlayRestoreError,
  } = require('../services/googlePlayRestoreService');
  const {
    AppleVerifierError,
  } = require('../services/appleSignedDataVerifier');
  const {
    generateGoogleObfuscatedAccountId,
  } = require('../services/googlePlaySubscriptionService');

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
    GOOGLE_PLAY_ENVIRONMENTS_ALLOWED: process.env.GOOGLE_PLAY_ENVIRONMENTS_ALLOWED,
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

  function configureAppleEnv() {
    process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC = 'com.yogatha.basic.monthly';
    process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO = 'com.yogatha.pro.monthly';
    process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED = 'sandbox,production';
  }

  function configureGoogleEnv() {
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'phase324-account-secret-phase324-account-secret';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.yogatha.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_OFFER_ID = 'basic_offer';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_OFFER_ID = 'pro_offer';
    process.env.GOOGLE_PLAY_ENVIRONMENTS_ALLOWED = 'test,production';
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

  function makeAppleDecoded({
    transactionId,
    originalTransactionId,
    productId = 'com.yogatha.basic.monthly',
    appAccountToken,
    environment = 'Sandbox',
    expiresOffsetMinutes = 60,
    revoked = false,
  }) {
    const now = Date.now();
    return {
      environment,
      transactionId,
      originalTransactionId,
      productId,
      appAccountToken,
      purchaseDate: now - 5 * 60 * 1000,
      originalPurchaseDate: now - 5 * 60 * 1000,
      expiresDate: now + expiresOffsetMinutes * 60 * 1000,
      signedDate: now,
      revocationDate: revoked ? now : null,
      subscriptionGroupIdentifier: 'group-1',
      offerDiscountType: null,
    };
  }

  function makeGoogleResponse({
    purchaseToken,
    externalAccountId,
    linkedPurchaseToken = null,
    productId = 'basic_product',
    basePlanId = 'basic_monthly',
    offerId = 'basic_offer',
    subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE',
    testPurchase = false,
    expiryMinutes = 60,
  }) {
    const now = new Date();
    return {
      etag: `etag-${purchaseToken}`,
      kind: 'androidpublisher#subscriptionPurchaseV2',
      regionCode: 'TR',
      startTime: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      linkedPurchaseToken,
      externalAccountIdentifiers: externalAccountId ? { obfuscatedExternalAccountId: externalAccountId } : {},
      subscriptionState,
      testPurchase: testPurchase ? {} : undefined,
      lineItems: [
        {
          productId,
          expiryTime: new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString(),
          latestSuccessfulOrderId: `GPA.${purchaseToken}`,
          autoRenewingPlan: { autoRenewEnabled: true },
          offerDetails: {
            basePlanId,
            offerId,
          },
          offerPhase: null,
        },
      ],
    };
  }

  function findRoute(router, method, routePath) {
    return (router.stack || []).find((layer) => layer.route
      && layer.route.path === routePath
      && layer.route.methods
      && layer.route.methods[method]);
  }

  await bootstrap();

  await test('apple restore unauthenticated is rejected', async () => {
    const res = makeRes();
    await subscriptionController.restoreAppleSubscription({ body: {} }, res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('apple restore malformed payload is rejected', async () => {
    configureAppleEnv();
    const { studio, user } = await createStudioWithUser('apple-malformed');
    const res = makeRes();
    await subscriptionController.restoreAppleSubscription({
      user: { id: user.id, studioId: studio.id },
      body: { signedTransactionInfo: 'not-jws' },
    }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.payload, { error: 'INVALID_RESTORE_REQUEST' });
  });

  await test('apple restore valid historical subscription restores and is idempotent', async () => {
    configureAppleEnv();
    const { studio } = await createStudioWithUser('apple-restore-success');
    const token = '11111111-1111-4111-8111-111111111111';

    await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'apple',
      targetPlan: 'basic',
      appAccountToken: token,
      googleObfuscatedAccountId: null,
      googleObfuscatedProfileId: null,
      status: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      createdByUserId: null,
      metadataJson: null,
    });

    const beforeIntentCount = await SubscriptionPurchaseIntent.count();

    const first = await restoreAppleSubscriptionForStudio({
      studioId: studio.id,
      body: { signedTransactionInfo: 'a.b.c' },
      dependencies: {
        verifyTransactionFn: async () => makeAppleDecoded({
          transactionId: 'tx-apple-1',
          originalTransactionId: 'orig-apple-1',
          appAccountToken: token,
        }),
      },
    });

    assert.strictEqual(first.restored, true);
    assert.strictEqual(first.alreadyKnown, false);

    const second = await restoreAppleSubscriptionForStudio({
      studioId: studio.id,
      body: { signedTransactionInfo: 'a.b.c' },
      dependencies: {
        verifyTransactionFn: async () => makeAppleDecoded({
          transactionId: 'tx-apple-1',
          originalTransactionId: 'orig-apple-1',
          appAccountToken: token,
        }),
      },
    });

    assert.strictEqual(second.restored, true);
    assert.strictEqual(second.alreadyKnown, true);
    assert.strictEqual(await SubscriptionPurchaseIntent.count(), beforeIntentCount);
  });

  await test('apple restore cross-studio binding is blocked', async () => {
    configureAppleEnv();
    const owner = await createStudioWithUser('apple-owner');
    const attacker = await createStudioWithUser('apple-attacker');

    await StudioSubscriptionEntitlement.create({
      studioId: owner.studio.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'com.yogatha.basic.monthly',
      providerSubscriptionId: 'orig-apple-conflict',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 60 * 60 * 1000),
      trialEndsAt: null,
      autoRenewEnabled: null,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: new Date(),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
      providerStateVersion: null,
      providerEventTime: new Date(),
    });

    await assert.rejects(
      restoreAppleSubscriptionForStudio({
        studioId: attacker.studio.id,
        body: { signedTransactionInfo: 'a.b.c' },
        dependencies: {
          verifyTransactionFn: async () => makeAppleDecoded({
            transactionId: 'tx-apple-2',
            originalTransactionId: 'orig-apple-conflict',
            appAccountToken: '22222222-2222-4222-8222-222222222222',
          }),
        },
      }),
      (error) => error instanceof AppleRestoreError && error.code === 'APPLE_SUBSCRIPTION_ALREADY_BOUND'
    );
  });

  await test('apple restore wrong bundle/env/product signals are blocked', async () => {
    configureAppleEnv();
    const { studio } = await createStudioWithUser('apple-verifier-errors');

    const assertions = [
      ['APPLE_BUNDLE_ID_MISMATCH', 'APPLE_TRANSACTION_APP_MISMATCH'],
      ['APPLE_ENVIRONMENT_NOT_ALLOWED', 'APPLE_TRANSACTION_ENVIRONMENT_NOT_ALLOWED'],
      ['APPLE_PRODUCT_NOT_ALLOWED', 'APPLE_PRODUCT_NOT_ALLOWED'],
    ];

    for (const [sourceCode, expectedCode] of assertions) {
      await assert.rejects(
        restoreAppleSubscriptionForStudio({
          studioId: studio.id,
          body: { signedTransactionInfo: 'a.b.c' },
          dependencies: {
            verifyTransactionFn: async () => {
              throw new AppleVerifierError(sourceCode, sourceCode);
            },
          },
        }),
        (error) => error instanceof AppleRestoreError && error.code === expectedCode
      );
    }
  });

  await test('apple restore revoked and expired statuses are normalized', async () => {
    configureAppleEnv();
    const { studio } = await createStudioWithUser('apple-revoked-expired');

    const tokenA = '33333333-3333-4333-8333-333333333333';
    await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'apple',
      targetPlan: 'basic',
      appAccountToken: tokenA,
      googleObfuscatedAccountId: null,
      googleObfuscatedProfileId: null,
      status: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      createdByUserId: null,
      metadataJson: null,
    });

    const revoked = await restoreAppleSubscriptionForStudio({
      studioId: studio.id,
      body: { signedTransactionInfo: 'a.b.c' },
      dependencies: {
        verifyTransactionFn: async () => makeAppleDecoded({
          transactionId: 'tx-apple-revoked',
          originalTransactionId: 'orig-apple-revoked',
          appAccountToken: tokenA,
          revoked: true,
        }),
      },
    });

    assert.strictEqual(revoked.normalizedStatus, 'revoked');

    const tokenB = '44444444-4444-4444-8444-444444444444';
    await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'apple',
      targetPlan: 'basic',
      appAccountToken: tokenB,
      googleObfuscatedAccountId: null,
      googleObfuscatedProfileId: null,
      status: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      createdByUserId: null,
      metadataJson: null,
    });

    const expired = await restoreAppleSubscriptionForStudio({
      studioId: studio.id,
      body: { signedTransactionInfo: 'a.b.c' },
      dependencies: {
        verifyTransactionFn: async () => makeAppleDecoded({
          transactionId: 'tx-apple-expired',
          originalTransactionId: 'orig-apple-expired',
          appAccountToken: tokenB,
          expiresOffsetMinutes: -1,
        }),
      },
    });

    assert.strictEqual(expired.normalizedStatus, 'expired');
  });

  await test('google restore unauthenticated is rejected', async () => {
    const res = makeRes();
    await subscriptionController.restoreGooglePlaySubscription({ body: {} }, res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('google restore malformed token is rejected', async () => {
    configureGoogleEnv();
    const { studio, user } = await createStudioWithUser('google-malformed');
    const res = makeRes();
    await subscriptionController.restoreGooglePlaySubscription({
      user: { id: user.id, studioId: studio.id },
      body: { purchaseToken: '' },
    }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.payload, { error: 'INVALID_RESTORE_REQUEST' });
  });

  await test('google restore valid historical subscription restores and is idempotent', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('google-restore-success');
    const token = 'purchase-token-1';
    const expectedAccountId = generateGoogleObfuscatedAccountId({
      studioId: studio.id,
      secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    });

    const runtimeConfig = {
      productConfiguration: {
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        basic: { productId: 'basic_product', basePlanId: 'basic_monthly', offerId: 'basic_offer' },
        pro: { productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'pro_offer' },
      },
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      accountHashSecret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
      allowedEnvironments: new Set(['production', 'test']),
    };

    const fakeClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({ purchaseToken: token, externalAccountId: expectedAccountId }) }),
        },
      },
    };

    const beforeIntents = await SubscriptionPurchaseIntent.count();

    const first = await restoreGooglePlaySubscriptionForStudio({
      studioId: studio.id,
      body: { purchaseToken: token },
      dependencies: {
        googleClient: fakeClient,
        runtimeConfig,
      },
    });

    assert.strictEqual(first.restored, true);
    assert.strictEqual(first.alreadyKnown, false);

    const second = await restoreGooglePlaySubscriptionForStudio({
      studioId: studio.id,
      body: { purchaseToken: token },
      dependencies: {
        googleClient: fakeClient,
        runtimeConfig,
      },
    });

    assert.strictEqual(second.restored, true);
    assert.strictEqual(second.alreadyKnown, true);
    assert.strictEqual(await SubscriptionPurchaseIntent.count(), beforeIntents);
  });

  await test('google restore token bound to another studio is blocked', async () => {
    configureGoogleEnv();
    const owner = await createStudioWithUser('google-owner');
    const attacker = await createStudioWithUser('google-attacker');

    await GooglePlaySubscriptionTransaction.create({
      studioId: owner.studio.id,
      environment: 'production',
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: 'basic_offer',
      purchaseToken: 'purchase-token-conflict',
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: 'GPA.1',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: new Date(Date.now() + 60 * 60 * 1000),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: 'x',
      rawApiResponseJson: '{}',
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    const expectedAccountId = generateGoogleObfuscatedAccountId({
      studioId: attacker.studio.id,
      secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    });

    const fakeClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({ purchaseToken: 'purchase-token-conflict', externalAccountId: expectedAccountId }) }),
        },
      },
    };

    const runtimeConfig = {
      productConfiguration: {
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        basic: { productId: 'basic_product', basePlanId: 'basic_monthly', offerId: 'basic_offer' },
        pro: { productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'pro_offer' },
      },
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      accountHashSecret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
      allowedEnvironments: new Set(['production']),
    };

    await assert.rejects(
      restoreGooglePlaySubscriptionForStudio({
        studioId: attacker.studio.id,
        body: { purchaseToken: 'purchase-token-conflict' },
        dependencies: { googleClient: fakeClient, runtimeConfig },
      }),
      (error) => error instanceof GooglePlayRestoreError && error.code === 'GOOGLE_PLAY_PURCHASE_ALREADY_BOUND'
    );
  });

  await test('google restore wrong account and unapproved mapping are blocked', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('google-invalid-mapping');

    const runtimeConfig = {
      productConfiguration: {
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        basic: { productId: 'basic_product', basePlanId: 'basic_monthly', offerId: 'basic_offer' },
        pro: { productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'pro_offer' },
      },
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      accountHashSecret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
      allowedEnvironments: new Set(['production']),
    };

    const wrongAccountClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({
            purchaseToken: 'purchase-token-account',
            externalAccountId: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          }) }),
        },
      },
    };

    await assert.rejects(
      restoreGooglePlaySubscriptionForStudio({
        studioId: studio.id,
        body: { purchaseToken: 'purchase-token-account' },
        dependencies: { googleClient: wrongAccountClient, runtimeConfig },
      }),
      (error) => error instanceof GooglePlayRestoreError && error.code === 'GOOGLE_PLAY_ACCOUNT_IDENTIFIER_MISMATCH'
    );

    const expectedAccountId = generateGoogleObfuscatedAccountId({
      studioId: studio.id,
      secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    });

    const badProductClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({
            purchaseToken: 'purchase-token-product',
            externalAccountId: expectedAccountId,
            productId: 'unknown_product',
          }) }),
        },
      },
    };

    await assert.rejects(
      restoreGooglePlaySubscriptionForStudio({
        studioId: studio.id,
        body: { purchaseToken: 'purchase-token-product' },
        dependencies: { googleClient: badProductClient, runtimeConfig },
      }),
      (error) => error instanceof GooglePlayRestoreError && error.code === 'GOOGLE_PLAY_PURCHASE_PLAN_MISMATCH'
    );
  });

  await test('google restore linked-token conflict and expired normalization behavior', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('google-linked-conflict');

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'basic_product',
      providerSubscriptionId: 'current-token',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 60 * 60 * 1000),
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
    });

    const runtimeConfig = {
      productConfiguration: {
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        basic: { productId: 'basic_product', basePlanId: 'basic_monthly', offerId: 'basic_offer' },
        pro: { productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'pro_offer' },
      },
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      accountHashSecret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
      allowedEnvironments: new Set(['production']),
    };

    const expectedAccountId = generateGoogleObfuscatedAccountId({
      studioId: studio.id,
      secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    });

    const conflictClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({
            purchaseToken: 'new-token',
            externalAccountId: expectedAccountId,
            linkedPurchaseToken: 'different-linked-token',
          }) }),
        },
      },
    };

    await assert.rejects(
      restoreGooglePlaySubscriptionForStudio({
        studioId: studio.id,
        body: { purchaseToken: 'new-token' },
        dependencies: { googleClient: conflictClient, runtimeConfig },
      }),
      (error) => error instanceof GooglePlayRestoreError && error.code === 'GOOGLE_PLAY_OTHER_SUBSCRIPTION_ACTIVE'
    );

    const expiredClient = {
      purchases: {
        subscriptionsv2: {
          get: async () => ({ data: makeGoogleResponse({
            purchaseToken: 'expired-token',
            externalAccountId: expectedAccountId,
            subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
            expiryMinutes: -5,
          }) }),
        },
      },
    };

    const expired = await restoreGooglePlaySubscriptionForStudio({
      studioId: studio.id,
      body: { purchaseToken: 'expired-token' },
      dependencies: { googleClient: expiredClient, runtimeConfig },
    });

    assert.strictEqual(expired.normalizedStatus, 'expired');
  });

  await test('restore endpoints are mounted and auth-protected', async () => {
    const appleRoute = findRoute(subscriptionRoutes, 'post', '/apple/restore');
    const googleRoute = findRoute(subscriptionRoutes, 'post', '/google-play/restore');

    assert.ok(appleRoute);
    assert.ok(googleRoute);

    const appleHandlers = appleRoute.route.stack.map((layer) => layer.handle.name).filter(Boolean);
    const googleHandlers = googleRoute.route.stack.map((layer) => layer.handle.name).filter(Boolean);

    assert.strictEqual(appleHandlers[0], 'authenticateToken');
    assert.strictEqual(appleHandlers[appleHandlers.length - 1], 'restoreAppleSubscription');

    assert.strictEqual(googleHandlers[0], 'authenticateToken');
    assert.strictEqual(googleHandlers[googleHandlers.length - 1], 'restoreGooglePlaySubscription');
  });

  await test('no fake purchase intents are created during restore', async () => {
    configureAppleEnv();
    configureGoogleEnv();

    const { studio } = await createStudioWithUser('restore-no-intents');
    const token = '55555555-5555-4555-8555-555555555555';

    await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'apple',
      targetPlan: 'basic',
      appAccountToken: token,
      googleObfuscatedAccountId: null,
      googleObfuscatedProfileId: null,
      status: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      createdByUserId: null,
      metadataJson: null,
    });

    const before = await SubscriptionPurchaseIntent.count();

    await restoreAppleSubscriptionForStudio({
      studioId: studio.id,
      body: { signedTransactionInfo: 'a.b.c' },
      dependencies: {
        verifyTransactionFn: async () => makeAppleDecoded({
          transactionId: 'tx-apple-no-intent',
          originalTransactionId: 'orig-apple-no-intent',
          appAccountToken: token,
        }),
      },
    });

    assert.strictEqual(await SubscriptionPurchaseIntent.count(), before);
  });

  await test('subscription enforcement middleware remains inactive', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.strictEqual(appSource.includes('requireActiveSubscription'), false);
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
