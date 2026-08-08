const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase322-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');
  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    StudioSubscriptionEntitlement,
    GooglePlaySubscriptionTransaction,
    GooglePubSubNotificationInbox,
  } = require('../models');
  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureGooglePlaySubscriptionTransactionsTable = require('../ensureGooglePlaySubscriptionTransactionsTable');
  const ensureGooglePubSubNotificationInboxTable = require('../ensureGooglePubSubNotificationInboxTable');

  const {
    generateGoogleObfuscatedAccountId,
  } = require('../services/googlePlaySubscriptionService');
  const {
    reconcileGooglePlayEntitlement,
    reconcileGooglePlayEntitlementBatch,
    retryDueGoogleRtdnInbox,
    GooglePlayReconciliationError,
  } = require('../services/googlePlayReconciliationService');

  const cli = require('./reconcileGooglePlaySubscriptions');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    DB_PATH: process.env.DB_PATH,
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID,
    GOOGLE_PLAY_RECONCILE_BATCH_SIZE: process.env.GOOGLE_PLAY_RECONCILE_BATCH_SIZE,
    GOOGLE_PLAY_RECONCILE_LOOKBACK_DAYS: process.env.GOOGLE_PLAY_RECONCILE_LOOKBACK_DAYS,
    GOOGLE_PLAY_NOTIFICATION_RETRY_BATCH_SIZE: process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BATCH_SIZE,
    GOOGLE_PLAY_NOTIFICATION_RETRY_BASE_MINUTES: process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BASE_MINUTES,
    GOOGLE_PLAY_NOTIFICATION_RETRY_MAX_MINUTES: process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_MAX_MINUTES,
    GOOGLE_PLAY_NOTIFICATION_MAX_ATTEMPTS: process.env.GOOGLE_PLAY_NOTIFICATION_MAX_ATTEMPTS,
    GOOGLE_PLAY_RECONCILIATION_HARNESS_MODULE: process.env.GOOGLE_PLAY_RECONCILIATION_HARNESS_MODULE,
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

  function addMinutes(baseDate, minutes) {
    return new Date(baseDate.getTime() + minutes * 60 * 1000);
  }

  function configureGoogleEnv() {
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'phase322-account-secret-phase322-account-secret';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.example.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PLAY_RECONCILE_BATCH_SIZE = '25';
    process.env.GOOGLE_PLAY_RECONCILE_LOOKBACK_DAYS = '7';
    process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BATCH_SIZE = '25';
    process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_BASE_MINUTES = '5';
    process.env.GOOGLE_PLAY_NOTIFICATION_RETRY_MAX_MINUTES = '360';
    process.env.GOOGLE_PLAY_NOTIFICATION_MAX_ATTEMPTS = '10';
  }

  function createFakeGoogleClient(responseOrError) {
    const calls = [];
    return {
      calls,
      client: {
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
      },
    };
  }

  function makeGoogleResponse({
    purchaseToken,
    externalAccountId,
    linkedPurchaseToken = null,
    productId = 'basic_product',
    basePlanId = 'basic_monthly',
    offerId = null,
    subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE',
    testPurchase = false,
    autoRenewEnabled = true,
    expiryMinutes = 60,
    etag = 'etag-1',
  }) {
    const now = new Date();
    return {
      etag,
      kind: 'androidpublisher#subscriptionPurchaseV2',
      regionCode: 'TR',
      startTime: addMinutes(now, -5).toISOString(),
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      linkedPurchaseToken,
      externalAccountIdentifiers: externalAccountId === null ? {} : { obfuscatedExternalAccountId: externalAccountId },
      subscriptionState,
      testPurchase: testPurchase ? {} : undefined,
      lineItems: [
        {
          productId,
          expiryTime: addMinutes(now, expiryMinutes).toISOString(),
          latestSuccessfulOrderId: `GPA.${purchaseToken}`,
          autoRenewingPlan: { autoRenewEnabled },
          offerDetails: { basePlanId, offerId },
          offerPhase: null,
        },
      ],
      canceledStateContext: subscriptionState === 'SUBSCRIPTION_STATE_CANCELED' ? { userInitiatedCancellation: {} } : undefined,
      inGracePeriodStateContext: subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ? { renewalDeclined: {} } : undefined,
      onHoldStateContext: subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD' ? { renewalDeclined: {} } : undefined,
      pausedStateContext: subscriptionState === 'SUBSCRIPTION_STATE_PAUSED' ? { autoResumeTime: addMinutes(now, 30).toISOString() } : undefined,
    };
  }

  async function createStudioWithUser(label) {
    const unique = `${label}-${Date.now().toString(36).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
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

  async function createGoogleEntitlement({
    studioId,
    purchaseToken,
    plan = 'basic',
    status = 'active',
    environment = 'production',
    productId = 'basic_product',
    lastVerifiedAt = new Date(),
    currentPeriodEnd = addMinutes(new Date(), 60),
  }) {
    return StudioSubscriptionEntitlement.create({
      studioId,
      provider: 'google_play',
      plan,
      normalizedStatus: status,
      providerProductId: productId,
      providerSubscriptionId: purchaseToken,
      currentPeriodStart: new Date(),
      currentPeriodEnd,
      trialEndsAt: null,
      autoRenewEnabled: true,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt,
      sourceLastUpdate: 'verify_endpoint',
      environment,
      providerStateVersion: 'etag-seeded',
      providerEventTime: new Date(),
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

  await test('imports are startup-safe and do not require credentials', async () => {
    const servicePath = path.join(__dirname, '..', 'services', 'googlePlayReconciliationService.js');
    const cliPath = path.join(__dirname, 'reconcileGooglePlaySubscriptions.js');

    delete require.cache[require.resolve(servicePath)];
    delete require.cache[require.resolve(cliPath)];

    const previousSecret = process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
    delete process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;

    const serviceModule = require(servicePath);
    const cliModule = require(cliPath);
    assert.ok(serviceModule);
    assert.ok(cliModule);

    if (typeof previousSecret === 'string') {
      process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = previousSecret;
    }
  });

  await test('missing entitlement is rejected', async () => {
    configureGoogleEnv();
    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: 999999,
        dependencies: {
          googleClient: createFakeGoogleClient({}).client,
        },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_ENTITLEMENT_NOT_FOUND'
    );
  });

  await test('non-google entitlement is rejected', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('apple-provider');
    const entitlement = await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'ios.basic',
      providerSubscriptionId: 'apple-original-1',
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 30),
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

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: entitlement.id,
        dependencies: {
          googleClient: createFakeGoogleClient({}).client,
        },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_PROVIDER_INVALID'
    );
  });

  await test('missing purchase token and unsupported environment are rejected', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('invalid-binding');

    const missingToken = await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'basic_product',
      providerSubscriptionId: null,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 30),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
    });

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: missingToken.id,
        dependencies: {
          googleClient: createFakeGoogleClient({}).client,
        },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_BINDING_INVALID'
    );

    const sandboxRow = await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'basic_product',
      providerSubscriptionId: 'sandbox-token',
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 30),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
    });

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: sandboxRow.id,
        dependencies: {
          googleClient: createFakeGoogleClient({}).client,
        },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_ENVIRONMENT_INVALID'
    );
  });

  await test('reconciliation repairs entitlement and transaction snapshot authoritatively', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('repair-success');
    const purchaseToken = 'phase322-repair-1';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const entitlement = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'expired',
      currentPeriodEnd: addMinutes(new Date(), -60),
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      etag: 'etag-phase322-a',
    }));

    const result = await reconcileGooglePlayEntitlement({
      entitlementId: entitlement.id,
      dependencies: {
        googleClient: fake.client,
      },
    });

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(result.entitlementId, entitlement.id);
    const savedEntitlement = await StudioSubscriptionEntitlement.findByPk(entitlement.id);
    assert.strictEqual(savedEntitlement.normalizedStatus, 'active');
    assert.strictEqual(savedEntitlement.plan, 'pro');
    assert.strictEqual(savedEntitlement.sourceLastUpdate, 'reconciliation');

    const tx = await GooglePlaySubscriptionTransaction.findOne({
      where: { environment: 'production', purchaseToken },
    });
    assert.ok(tx);
    assert.strictEqual(tx.acknowledgementState, 'ACKNOWLEDGEMENT_STATE_PENDING');
  });

  await test('ownership and environment mismatch are rejected', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('ownership');
    const purchaseToken = 'phase322-own-1';
    const goodAccountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const entitlement = await createGoogleEntitlement({ studioId: studio.id, purchaseToken });

    const wrongAccount = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: generateGoogleObfuscatedAccountId({ studioId: studio.id + 100, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET }),
    }));

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: entitlement.id,
        dependencies: { googleClient: wrongAccount.client },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH'
    );

    const envMismatch = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: goodAccountId,
      testPurchase: true,
    }));

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: entitlement.id,
        dependencies: { googleClient: envMismatch.client },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH'
    );
  });

  await test('cross-provider effective entitlement blocks google activation', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('cross-provider');
    const purchaseToken = 'phase322-cross-1';

    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'ios.basic',
      providerSubscriptionId: 'apple-original-cross-1',
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 120),
      sourceLastUpdate: 'reconciliation',
      environment: 'production',
    });

    const entitlement = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'expired',
      currentPeriodEnd: addMinutes(new Date(), -10),
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    }));

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: entitlement.id,
        dependencies: { googleClient: fake.client },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_OTHER_PROVIDER_ACTIVE'
    );
  });

  await test('stale response is safely skipped and does not regress newer state', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('stale');
    const purchaseToken = 'phase322-stale-1';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const entitlement = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'active',
      currentPeriodEnd: addMinutes(new Date(), 180),
    });

    await entitlement.update({
      providerEventTime: addMinutes(new Date(), 120),
      lastVerifiedAt: addMinutes(new Date(), 120),
    });

    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'production',
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: null,
      purchaseToken,
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: `GPA.${purchaseToken}`,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: addMinutes(new Date(), 180),
      rawApiResponseJson: JSON.stringify({ seeded: true }),
      providerEventTime: addMinutes(new Date(), 120),
      ingestedAt: addMinutes(new Date(), 120),
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      expiryMinutes: -120,
    }));

    const result = await reconcileGooglePlayEntitlement({
      entitlementId: entitlement.id,
      dependencies: { googleClient: fake.client },
    });

    assert.strictEqual(result.staleSkipped, true);
    const saved = await StudioSubscriptionEntitlement.findByPk(entitlement.id);
    assert.strictEqual(saved.normalizedStatus, 'active');
  });

  await test('old-token reconciliation cannot reactivate superseded effective entitlement', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('replacement-protection');
    const oldToken = 'phase322-old-token';
    const newToken = 'phase322-new-token';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const oldEntitlement = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken: oldToken,
      status: 'expired',
      currentPeriodEnd: addMinutes(new Date(), -20),
    });

    await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken: newToken,
      status: 'active',
      currentPeriodEnd: addMinutes(new Date(), 200),
      plan: 'pro',
      productId: 'pro_product',
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: oldToken,
      externalAccountId: accountId,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    }));

    await assert.rejects(
      reconcileGooglePlayEntitlement({
        entitlementId: oldEntitlement.id,
        dependencies: { googleClient: fake.client },
      }),
      (error) => error instanceof GooglePlayReconciliationError && error.code === 'GOOGLE_PLAY_RECONCILIATION_ACTIVE_CONFLICT'
    );
  });

  await test('retry due failed RTDN reuses stored authenticated message and succeeds without OIDC header', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('retry-success');
    const purchaseToken = 'phase322-retry-token-1';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'production',
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: null,
      purchaseToken,
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: `GPA.${purchaseToken}`,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: addMinutes(new Date(), 60),
      rawApiResponseJson: JSON.stringify({ seeded: true }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'active',
      environment: 'production',
    });

    await GooglePubSubNotificationInbox.create({
      environment: 'unresolved',
      pubsubMessageId: 'phase322-retry-msg-1',
      publishTime: new Date(),
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      purchaseToken,
      subscriptionNotificationType: '2',
      oneTimeProductNotificationType: null,
      testNotificationFlag: false,
      rawPayloadJson: JSON.stringify({
        subscription: 'projects/demo/subscriptions/demo-rtdn',
        message: {
          messageId: 'phase322-retry-msg-1',
          publishTime: new Date().toISOString(),
          attributes: { source: 'rtdn' },
        },
        notification: {
          version: '1.0',
          packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
          eventTimeMillis: String(Date.now()),
          kind: 'subscription',
          subscriptionNotification: {
            version: '1.0',
            notificationType: 2,
            purchaseToken,
          },
          oneTimeProductNotification: null,
          voidedPurchaseNotification: null,
          pendingRefundReviewNotification: null,
          testNotification: null,
        },
      }),
      processingState: 'failed',
      processedAt: null,
      lastError: 'TEMP',
      attemptCount: 1,
      nextAttemptAt: addMinutes(new Date(), -1),
    });

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    }));

    const result = await retryDueGoogleRtdnInbox({
      dependencies: { googleClient: fake.client },
    });

    assert.strictEqual(result.selected, 1);
    assert.strictEqual(result.succeeded, 1);
    const inbox = await GooglePubSubNotificationInbox.findOne({ where: { pubsubMessageId: 'phase322-retry-msg-1' } });
    assert.strictEqual(inbox.processingState, 'processed');
    assert.strictEqual(fake.calls.length, 1);
  });

  await test('retry selects only due failed rows and preserves others', async () => {
    configureGoogleEnv();

    await GooglePubSubNotificationInbox.create({
      environment: 'unresolved',
      pubsubMessageId: 'phase322-not-due-1',
      publishTime: new Date(),
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      purchaseToken: 'phase322-not-due-token',
      rawPayloadJson: '{}',
      processingState: 'failed',
      attemptCount: 1,
      nextAttemptAt: addMinutes(new Date(), 30),
    });

    await GooglePubSubNotificationInbox.create({
      environment: 'unresolved',
      pubsubMessageId: 'phase322-processed-skip',
      publishTime: new Date(),
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      purchaseToken: 'phase322-processed-token',
      rawPayloadJson: '{}',
      processingState: 'processed',
      attemptCount: 1,
      nextAttemptAt: addMinutes(new Date(), -30),
    });

    const result = await retryDueGoogleRtdnInbox({
      dependencies: {
        googleClient: createFakeGoogleClient({}).client,
      },
    });

    assert.strictEqual(result.selected >= 0, true);
    const notDue = await GooglePubSubNotificationInbox.findOne({ where: { pubsubMessageId: 'phase322-not-due-1' } });
    assert.strictEqual(notDue.processingState, 'failed');
  });

  await test('batch dry-run selects without mutation and without API calls', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('batch-dry-run');
    const purchaseToken = 'phase322-batch-dry-1';

    await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'active',
      lastVerifiedAt: addMinutes(new Date(), -24 * 60),
    });

    let factoryCalls = 0;
    const summary = await reconcileGooglePlayEntitlementBatch({
      dryRun: true,
      dependencies: {
        googleClientFactory: () => {
          factoryCalls += 1;
          return createFakeGoogleClient({}).client;
        },
      },
    });

    assert.strictEqual(summary.selected >= 1, true);
    assert.strictEqual(summary.succeeded, 0);
    assert.strictEqual(factoryCalls, 0);
  });

  await test('batch reconciliation handles per-row failures without stopping', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('batch-fail-safe');
    const tokenA = 'phase322-batch-a';
    const tokenB = 'phase322-batch-b';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const entA = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken: tokenA,
      status: 'active',
      lastVerifiedAt: addMinutes(new Date(), -24 * 60),
    });

    const entB = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken: tokenB,
      status: 'cancelled',
      lastVerifiedAt: addMinutes(new Date(), -24 * 60 - 10),
    });

    const fakeClient = {
      purchases: {
        subscriptionsv2: {
          get: async ({ token }) => {
            if (token === tokenA) {
              return {
                data: makeGoogleResponse({
                  purchaseToken: tokenA,
                  externalAccountId: accountId,
                  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                }),
              };
            }

            const err = new Error('Not found');
            err.response = {
              status: 404,
              data: {
                error: {
                  status: 'NOT_FOUND',
                  errors: [{ reason: 'notFound' }],
                },
              },
            };
            throw err;
          },
        },
      },
    };

    const summary = await reconcileGooglePlayEntitlementBatch({
      limit: 100,
      dryRun: false,
      now: new Date(),
      dependencies: { googleClient: fakeClient },
    });

    assert.strictEqual(summary.selected >= 2, true);
    assert.strictEqual(summary.succeeded + summary.failed, summary.selected);
    assert.strictEqual(summary.succeeded >= 1, true);
    assert.strictEqual(summary.failed >= 1, true);
  });

  await test('CLI help and explicit mode validation work', async () => {
    const help = await cli.run(['--help']);
    assert.strictEqual(help.mode, 'help');

    await assert.rejects(
      cli.run([]),
      (error) => error instanceof Error && error.message.includes('No mode selected')
    );

    await assert.rejects(
      cli.run(['--retry-notifications', '--dry-run']),
      (error) => error instanceof Error && error.message.includes('--dry-run cannot be used with --retry-notifications')
    );
  });

  await test('CLI entitlement and batch modes execute with harness dependency injection', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('cli-single');
    const purchaseToken = 'phase322-cli-token-1';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    const entitlement = await createGoogleEntitlement({
      studioId: studio.id,
      purchaseToken,
      status: 'expired',
      currentPeriodEnd: addMinutes(new Date(), -5),
    });

    const harnessPath = path.join(tmpRoot, 'phase322-harness.js');
    fs.writeFileSync(
      harnessPath,
      `module.exports = {\n  googleClient: {\n    purchases: {\n      subscriptionsv2: {\n        get: async ({ token }) => ({\n          data: {\n            etag: 'etag-cli',\n            kind: 'androidpublisher#subscriptionPurchaseV2',\n            regionCode: 'TR',\n            startTime: new Date().toISOString(),\n            acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',\n            linkedPurchaseToken: null,\n            externalAccountIdentifiers: { obfuscatedExternalAccountId: '${accountId}' },\n            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',\n            lineItems: [{\n              productId: 'basic_product',\n              expiryTime: new Date(Date.now() + 3600000).toISOString(),\n              latestSuccessfulOrderId: 'GPA.' + token,\n              autoRenewingPlan: { autoRenewEnabled: true },\n              offerDetails: { basePlanId: 'basic_monthly', offerId: null },\n              offerPhase: null,\n            }],\n          },\n        }),\n      },\n    },\n  },\n};\n`
    );

    process.env.GOOGLE_PLAY_RECONCILIATION_HARNESS_MODULE = harnessPath;

    const single = await cli.run([`--entitlement-id=${entitlement.id}`]);
    assert.ok(single.reconcile);

    const batch = await cli.run(['--batch', '--batch-size=1', '--dry-run']);
    assert.ok(batch.batch);
    assert.strictEqual(batch.dryRun, true);
  });

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
