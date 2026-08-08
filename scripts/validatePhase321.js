const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase321-'));
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

  const subscriptionRoute = require('../routes/subscription');
  const subscriptionController = require('../controllers/subscriptionController');
  const googleRtdnController = require('../controllers/googlePlayRtdnController');
  const {
    GooglePubSubAuthError,
    verifyGooglePubSubPushRequest,
  } = require('../services/googlePubSubPushAuthenticator');
  const {
    GooglePlayRtdnError,
    ingestGooglePlayNotification,
    validateGooglePubSubEnvelope,
    decodeGooglePubSubMessageData,
    validateGoogleDeveloperNotification,
    classifyGoogleDeveloperNotification,
  } = require('../services/googlePlayRtdnService');
  const {
    generateGoogleObfuscatedAccountId,
  } = require('../services/googlePlaySubscriptionService');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID,
    GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID,
    GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID: process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID,
    GOOGLE_PUBSUB_PUSH_AUDIENCE: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
    GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
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

  function makeReq({ body, contentType = 'application/json', authorization } = {}) {
    return {
      body,
      headers: authorization ? { authorization } : {},
      is(type) {
        return type === contentType ? contentType : false;
      },
      get(name) {
        return name && name.toLowerCase() === 'authorization' ? authorization || null : null;
      },
    };
  }

  function addMinutes(baseDate, minutes) {
    return new Date(baseDate.getTime() + minutes * 60 * 1000);
  }

  function buildDeveloperNotification({
    packageName = 'com.example.app',
    eventTimeMillis = Date.now(),
    subscriptionNotification,
    oneTimeProductNotification,
    voidedPurchaseNotification,
    pendingRefundReviewNotification,
    testNotification,
  }) {
    return JSON.stringify({
      version: '1.0',
      packageName,
      eventTimeMillis: String(eventTimeMillis),
      subscriptionNotification,
      oneTimeProductNotification,
      voidedPurchaseNotification,
      pendingRefundReviewNotification,
      testNotification,
    });
  }

  function buildPushBody(notification, { messageId = 'msg-1', publishTime = new Date().toISOString() } = {}) {
    return {
      message: {
        data: Buffer.from(notification, 'utf8').toString('base64'),
        messageId,
        publishTime,
        attributes: { source: 'rtdn' },
      },
      subscription: 'projects/demo/subscriptions/demo-rtdn',
    };
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

  async function createStudioWithUser(label) {
    const unique = `${label}-${Date.now().toString(36).slice(-6)}`;
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

  function configureGoogleEnv() {
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'phase321-account-secret';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.example.app';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_PRODUCT_ID = 'basic_product';
    process.env.GOOGLE_PLAY_ALLOWED_BASIC_BASE_PLAN_ID = 'basic_monthly';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_PRODUCT_ID = 'pro_product';
    process.env.GOOGLE_PLAY_ALLOWED_PRO_BASE_PLAN_ID = 'pro_monthly';
    process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE = 'https://example.com/pubsub';
    process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL = 'pubsub@example.iam.gserviceaccount.com';
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

  await bootstrap();

  await test('route exposes public google notifications endpoint', async () => {
    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
    assert.ok(routeSource.includes("/google-play/notifications"));
    assert.ok(!routeSource.includes("/google-play/notifications', authenticateToken"));
  });

  await test('push authentication accepts injected identity and rejects malformed headers', async () => {
    await assert.rejects(
      verifyGooglePubSubPushRequest({
        authorizationHeader: 'Bearer',
        expectedAudience: 'https://example.com/pubsub',
        expectedServiceAccountEmail: 'pubsub@example.iam.gserviceaccount.com',
      }),
      (error) => error instanceof GooglePubSubAuthError && error.code === 'GOOGLE_PUBSUB_AUTH_INVALID'
    );

    const result = await verifyGooglePubSubPushRequest({
      authorizationHeader: 'Bearer fake-token',
      expectedAudience: 'https://example.com/pubsub',
      expectedServiceAccountEmail: 'pubsub@example.iam.gserviceaccount.com',
      dependencies: {
        tokenVerifier: async () => ({
          payload: {
            aud: 'https://example.com/pubsub',
            email: 'pubsub@example.iam.gserviceaccount.com',
            email_verified: true,
            iss: 'https://accounts.google.com',
          },
        }),
      },
    });

    assert.deepStrictEqual(result, { verified: true });
  });

  await test('envelope and developer notification validation reject malformed payloads', async () => {
    assert.throws(() => validateGooglePubSubEnvelope(null), (error) => error instanceof GooglePlayRtdnError);
    assert.throws(() => validateGooglePubSubEnvelope({}), (error) => error instanceof GooglePlayRtdnError);
    assert.throws(() => validateGooglePubSubEnvelope({ message: {} }), (error) => error instanceof GooglePlayRtdnError);
    assert.throws(() => validateGooglePubSubEnvelope({ message: { data: 'abc', messageId: '' }, subscription: 's' }), (error) => error instanceof GooglePlayRtdnError);
    assert.throws(() => decodeGooglePubSubMessageData('***'), (error) => error instanceof GooglePlayRtdnError);

    const notification = JSON.parse(buildDeveloperNotification({
      subscriptionNotification: {
        version: '1.0',
        notificationType: 4,
        purchaseToken: 'token-1',
      },
    }));

    assert.strictEqual(classifyGoogleDeveloperNotification(notification), 'subscription');
    assert.throws(() => validateGoogleDeveloperNotification({ version: '1.0', packageName: 'pkg', eventTimeMillis: '1', subscriptionNotification: {}, testNotification: {} }), (error) => error instanceof GooglePlayRtdnError);
  });

  await test('test notification is stored and processed without developer api calls', async () => {
    configureGoogleEnv();
    const body = buildPushBody(
      buildDeveloperNotification({
        testNotification: { version: '1.0' },
      }),
      { messageId: 'test-msg-1' }
    );

    const result = await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    assert.deepStrictEqual(result, { acknowledged: true, status: 'processed' });
    assert.strictEqual(await GooglePubSubNotificationInbox.count({ where: { pubsubMessageId: 'test-msg-1' } }), 1);
  });

  await test('one-time product notification is accepted as safe no-op', async () => {
    configureGoogleEnv();
    const body = buildPushBody(
      buildDeveloperNotification({
        oneTimeProductNotification: {
          version: '1.0',
          notificationType: 1,
          purchaseToken: 'one-time-token',
          sku: 'sku-1',
        },
      }),
      { messageId: 'one-time-msg-1' }
    );

    const result = await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    assert.deepStrictEqual(result, { acknowledged: true, status: 'processed' });
  });

  await test('subscription notification refreshes authoritative state and persists rows', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('subscription');
    const purchaseToken = 'purchase-subscription-1';
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
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: accountId,
      rawApiResponseJson: JSON.stringify({ seeded: true }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'basic_product',
      providerSubscriptionId: purchaseToken,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 60),
      autoRenewEnabled: true,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      lastVerifiedAt: new Date(),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      providerStateVersion: 'etag-seeded',
      providerEventTime: new Date(),
    });

    const response = makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    });
    const fake = createFakeGoogleClient(response);
    const body = buildPushBody(
      buildDeveloperNotification({
        subscriptionNotification: {
          version: '1.0',
          notificationType: 2,
          purchaseToken,
        },
      }),
      { messageId: 'subscription-msg-1' }
    );

    const result = await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        googleClient: fake.client,
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    assert.deepStrictEqual(result, { acknowledged: true, status: 'processed' });
    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(await GooglePlaySubscriptionTransaction.count({ where: { purchaseToken, environment: 'production' } }), 1);
    assert.strictEqual(await StudioSubscriptionEntitlement.count({ where: { studioId: studio.id, provider: 'google_play', providerSubscriptionId: purchaseToken } }), 1);
    const inbox = await GooglePubSubNotificationInbox.findOne({ where: { pubsubMessageId: 'subscription-msg-1' } });
    assert.strictEqual(inbox.processingState, 'processed');
    assert.strictEqual(inbox.environment, 'production');
  });

  await test('duplicate message id returns success without duplicate inbox rows', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('duplicate');
    const purchaseToken = 'purchase-dup-1';
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
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: accountId,
      rawApiResponseJson: JSON.stringify({ seeded: true }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'basic_product',
      providerSubscriptionId: purchaseToken,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addMinutes(new Date(), 60),
      autoRenewEnabled: true,
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      lastVerifiedAt: new Date(),
    });

    const response = makeGoogleResponse({
      purchaseToken,
      externalAccountId: accountId,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
    });
    const fake = createFakeGoogleClient(response);
    const body = buildPushBody(
      buildDeveloperNotification({
        subscriptionNotification: {
          version: '1.0',
          notificationType: 2,
          purchaseToken,
        },
      }),
      { messageId: 'subscription-msg-dup' }
    );

    await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        googleClient: fake.client,
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        googleClient: fake.client,
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    assert.strictEqual(await GooglePubSubNotificationInbox.count({ where: { pubsubMessageId: 'subscription-msg-dup' } }), 1);
    assert.strictEqual(fake.calls.length, 1);
  });

  await test('missing binding records retryable failure state', async () => {
    configureGoogleEnv();
    const body = buildPushBody(
      buildDeveloperNotification({
        subscriptionNotification: {
          version: '1.0',
          notificationType: 4,
          purchaseToken: 'purchase-missing-binding',
        },
      }),
      { messageId: 'missing-binding-msg-1' }
    );

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: 'purchase-missing-binding',
      externalAccountId: generateGoogleObfuscatedAccountId({ studioId: 9999, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET }),
    }));

    await assert.rejects(
      ingestGooglePlayNotification({
        authorizationHeader: 'Bearer fake-token',
        body,
        dependencies: {
          googleClient: fake.client,
          pushAuthDependencies: {
            tokenVerifier: async () => ({
              payload: {
                aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
                email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
                email_verified: true,
                iss: 'https://accounts.google.com',
              },
            }),
          },
        },
      }),
      (error) => error instanceof GooglePlayRtdnError && error.code === 'GOOGLE_PLAY_NOTIFICATION_BINDING_NOT_FOUND'
    );

    const inbox = await GooglePubSubNotificationInbox.findOne({ where: { pubsubMessageId: 'missing-binding-msg-1' } });
    assert.strictEqual(inbox.processingState, 'failed');
    assert.ok(inbox.nextAttemptAt instanceof Date || inbox.nextAttemptAt === null);
  });

  await test('linked purchase replacement retires old same-studio entitlement', async () => {
    configureGoogleEnv();
    const { studio } = await createStudioWithUser('replacement');
    const oldToken = 'purchase-old-321';
    const newToken = 'purchase-new-321';
    const accountId = generateGoogleObfuscatedAccountId({ studioId: studio.id, secret: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET });

    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'production',
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: null,
      purchaseToken: oldToken,
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: `GPA.${oldToken}`,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: addMinutes(new Date(), 30),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: accountId,
      rawApiResponseJson: JSON.stringify({ seeded: true }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
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

    const fake = createFakeGoogleClient(makeGoogleResponse({
      purchaseToken: newToken,
      linkedPurchaseToken: oldToken,
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      externalAccountId: accountId,
    }));

    const body = buildPushBody(
      buildDeveloperNotification({
        subscriptionNotification: {
          version: '1.0',
          notificationType: 4,
          purchaseToken: newToken,
        },
      }),
      { messageId: 'linked-replacement-msg-1' }
    );

    const result = await ingestGooglePlayNotification({
      authorizationHeader: 'Bearer fake-token',
      body,
      dependencies: {
        googleClient: fake.client,
        pushAuthDependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
              email: process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL,
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      },
    });

    assert.deepStrictEqual(result, { acknowledged: true, status: 'processed' });
    const oldEntitlement = await StudioSubscriptionEntitlement.findOne({ where: { studioId: studio.id, provider: 'google_play', providerSubscriptionId: oldToken } });
    const newEntitlement = await StudioSubscriptionEntitlement.findOne({ where: { studioId: studio.id, provider: 'google_play', providerSubscriptionId: newToken } });
    assert.ok(['cancelled', 'expired'].includes(oldEntitlement.normalizedStatus));
    assert.strictEqual(newEntitlement.normalizedStatus, 'active');
  });

  await test('controller returns generic response for invalid callback shape', async () => {
    const res = makeRes();
    await googleRtdnController.handleGooglePlayRtdnNotification(makeReq({ body: null }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.payload, { error: 'Notification processing failed' });
  });

  await test('invalid token claims are rejected', async () => {
    await assert.rejects(
      verifyGooglePubSubPushRequest({
        authorizationHeader: 'Bearer fake-token',
        expectedAudience: 'https://example.com/pubsub',
        expectedServiceAccountEmail: 'pubsub@example.iam.gserviceaccount.com',
        dependencies: {
          tokenVerifier: async () => ({
            payload: {
              aud: 'wrong',
              email: 'pubsub@example.iam.gserviceaccount.com',
              email_verified: true,
              iss: 'https://accounts.google.com',
            },
          }),
        },
      }),
      (error) => error instanceof GooglePubSubAuthError && error.code === 'GOOGLE_PUBSUB_AUTH_AUDIENCE_MISMATCH'
    );
  });

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});