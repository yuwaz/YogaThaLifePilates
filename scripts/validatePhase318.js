const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase318-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');

  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    StudioSubscriptionEntitlement,
    SubscriptionPurchaseIntent,
    AppleSubscriptionTransaction,
    AppleServerNotificationInbox,
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

  const gpMeta = require('../models/googlePlaySubscriptionMetadata');
  const gpService = require('../services/googlePlaySubscriptionService');
  const gpClient = require('../services/googlePlayDeveloperClient');

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

  function normalizeDate(date) {
    return date instanceof Date ? date.toISOString() : null;
  }

  function compactJwsLikeToken(label) {
    return `${String(label).replace(/[^a-zA-Z0-9_-]/g, '') || 'x'}.payload.signature`;
  }

  await bootstrap();
  await bootstrap();

  const studio = await Studio.findByPk(1);
  assert.ok(studio, 'Studio 1 should exist');

  const [tableRows] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tableRows.map((row) => row.name));

  await test('google tables exist after fresh bootstrap', async () => {
    assert.ok(tableNames.has('google_play_subscription_transactions'));
    assert.ok(tableNames.has('google_pubsub_notification_inbox'));
  });

  await test('provider-neutral and apple tables still exist', async () => {
    assert.ok(tableNames.has('StudioSubscriptionEntitlements'));
    assert.ok(tableNames.has('SubscriptionPurchaseIntents'));
    assert.ok(tableNames.has('apple_subscription_transactions'));
    assert.ok(tableNames.has('apple_server_notification_inbox'));
  });

  async function getColumns(tableName) {
    const [rows] = await sequelize.query(`PRAGMA table_info(\"${tableName}\")`);
    return rows.map((row) => row.name);
  }

  async function getIndexNames(tableName) {
    const [rows] = await sequelize.query(`PRAGMA index_list(\"${tableName}\")`);
    return rows.map((row) => row.name);
  }

  await test('google transaction columns exist', async () => {
    const columns = await getColumns('google_play_subscription_transactions');
    const required = [
      'id', 'studioId', 'environment', 'packageName', 'productId', 'basePlanId', 'offerId',
      'purchaseToken', 'linkedPurchaseToken', 'latestSuccessfulOrderId', 'subscriptionState',
      'acknowledgementState', 'autoRenewEnabled', 'startTime', 'expiryTime',
      'cancelSurveyResultJson', 'cancellationContextJson', 'testPurchaseFlag',
      'externalAccountIdentifier', 'rawApiResponseJson', 'providerEventTime', 'ingestedAt',
      'createdAt', 'updatedAt',
    ];
    for (const name of required) {
      assert.ok(columns.includes(name), `Missing column: ${name}`);
    }
  });

  await test('google pubsub inbox columns exist', async () => {
    const columns = await getColumns('google_pubsub_notification_inbox');
    const required = [
      'id', 'environment', 'pubsubMessageId', 'publishTime', 'packageName', 'purchaseToken',
      'subscriptionNotificationType', 'oneTimeProductNotificationType', 'testNotificationFlag',
      'rawPayloadJson', 'processingState', 'processedAt', 'lastError', 'attemptCount',
      'nextAttemptAt', 'createdAt', 'updatedAt',
    ];
    for (const name of required) {
      assert.ok(columns.includes(name), `Missing column: ${name}`);
    }
  });

  await test('google transaction indexes exist', async () => {
    const names = await getIndexNames('google_play_subscription_transactions');
    const required = [
      'google_play_subscription_transactions_environment_purchase_token_unique',
      'google_play_subscription_transactions_studio_id_idx',
      'google_play_subscription_transactions_environment_linked_purchase_token_idx',
      'google_play_subscription_transactions_package_product_idx',
      'google_play_subscription_transactions_expiry_time_idx',
      'google_play_subscription_transactions_ingested_at_idx',
      'google_play_subscription_transactions_provider_event_time_idx',
      'google_play_subscription_transactions_latest_successful_order_id_idx',
    ];

    for (const name of required) {
      assert.ok(names.includes(name), `Missing index: ${name}`);
    }
  });

  await test('google pubsub inbox indexes exist', async () => {
    const names = await getIndexNames('google_pubsub_notification_inbox');
    const required = [
      'google_pubsub_notification_inbox_environment_message_id_unique',
      'google_pubsub_notification_inbox_processing_state_idx',
      'google_pubsub_notification_inbox_next_attempt_at_idx',
      'google_pubsub_notification_inbox_environment_purchase_token_idx',
      'google_pubsub_notification_inbox_publish_time_idx',
      'google_pubsub_notification_inbox_created_at_idx',
      'google_pubsub_notification_inbox_package_name_idx',
    ];

    for (const name of required) {
      assert.ok(names.includes(name), `Missing index: ${name}`);
    }
  });

  await test('foreign key references Studios for google transactions', async () => {
    const result = await sequelize.query('PRAGMA foreign_key_list("google_play_subscription_transactions")');
    const rows = Array.isArray(result[0]) ? result[0] : result;
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((row) => row.table === 'Studios' && row.from === 'studioId'));
  });

  await test('duplicate purchaseToken in same environment is rejected', async () => {
    const payload = {
      studioId: studio.id,
      environment: 'test',
      packageName: 'com.example.app',
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: null,
      purchaseToken: 'purchase-token-1',
      linkedPurchaseToken: 'old-token',
      latestSuccessfulOrderId: 'GPA.1',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: new Date(Date.now() + 3600 * 1000),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: true,
      externalAccountIdentifier: 'abcdef',
      rawApiResponseJson: JSON.stringify({ kind: 'androidpublisher#subscriptionPurchaseV2' }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    };

    await GooglePlaySubscriptionTransaction.create(payload);

    await assert.rejects(
      GooglePlaySubscriptionTransaction.create(payload),
      /Validation error|UNIQUE constraint failed/
    );
  });

  await test('same purchaseToken across test and production is allowed', async () => {
    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'production',
      packageName: 'com.example.app',
      productId: 'basic_product',
      basePlanId: 'basic_monthly',
      offerId: null,
      purchaseToken: 'purchase-token-1',
      linkedPurchaseToken: null,
      latestSuccessfulOrderId: null,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: new Date(Date.now() + 7200 * 1000),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: 'bbbbbb',
      rawApiResponseJson: JSON.stringify({ kind: 'androidpublisher#subscriptionPurchaseV2' }),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });
  });

  await test('multiple rows may share linkedPurchaseToken', async () => {
    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'test',
      packageName: 'com.example.app',
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      offerId: null,
      purchaseToken: 'purchase-token-2',
      linkedPurchaseToken: 'shared-linked-token',
      latestSuccessfulOrderId: null,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      autoRenewEnabled: true,
      startTime: new Date(),
      expiryTime: new Date(Date.now() + 3600 * 1000),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: true,
      externalAccountIdentifier: 'cccccc',
      rawApiResponseJson: JSON.stringify({}),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });

    await GooglePlaySubscriptionTransaction.create({
      studioId: studio.id,
      environment: 'production',
      packageName: 'com.example.app',
      productId: 'pro_product',
      basePlanId: 'pro_monthly',
      offerId: null,
      purchaseToken: 'purchase-token-3',
      linkedPurchaseToken: 'shared-linked-token',
      latestSuccessfulOrderId: null,
      subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      autoRenewEnabled: false,
      startTime: new Date(),
      expiryTime: new Date(Date.now() + 3600 * 1000),
      cancelSurveyResultJson: null,
      cancellationContextJson: null,
      testPurchaseFlag: false,
      externalAccountIdentifier: 'dddddd',
      rawApiResponseJson: JSON.stringify({}),
      providerEventTime: new Date(),
      ingestedAt: new Date(),
    });
  });

  await test('duplicate pubsubMessageId in same environment is rejected', async () => {
    const payload = {
      environment: 'test',
      pubsubMessageId: 'msg-1',
      publishTime: new Date(),
      packageName: 'com.example.app',
      purchaseToken: 'purchase-token-1',
      subscriptionNotificationType: 'SUBSCRIPTION_RECOVERED',
      oneTimeProductNotificationType: null,
      testNotificationFlag: true,
      rawPayloadJson: JSON.stringify({ id: 1 }),
      processingState: 'pending',
      processedAt: null,
      lastError: null,
      attemptCount: 0,
      nextAttemptAt: null,
    };

    await GooglePubSubNotificationInbox.create(payload);
    await assert.rejects(
      GooglePubSubNotificationInbox.create(payload),
      /Validation error|UNIQUE constraint failed/
    );
  });

  await test('same pubsubMessageId across environments is allowed', async () => {
    await GooglePubSubNotificationInbox.create({
      environment: 'production',
      pubsubMessageId: 'msg-1',
      publishTime: new Date(),
      packageName: 'com.example.app',
      purchaseToken: 'purchase-token-x',
      subscriptionNotificationType: 'SUBSCRIPTION_RENEWED',
      oneTimeProductNotificationType: null,
      testNotificationFlag: false,
      rawPayloadJson: JSON.stringify({ id: 2 }),
      processingState: 'pending',
      processedAt: null,
      lastError: null,
      attemptCount: 0,
      nextAttemptAt: null,
    });
  });

  await test('notification defaults are pending and attemptCount 0', async () => {
    const row = await GooglePubSubNotificationInbox.create({
      environment: 'test',
      pubsubMessageId: 'msg-2',
      rawPayloadJson: JSON.stringify({}),
    });

    assert.strictEqual(row.processingState, 'pending');
    assert.strictEqual(row.attemptCount, 0);
  });

  await test('invalid Google transaction environment rejected', async () => {
    await assert.rejects(
      GooglePlaySubscriptionTransaction.create({
        studioId: studio.id,
        environment: 'sandbox',
        packageName: 'com.example.app',
        productId: 'basic_product',
        purchaseToken: 'purchase-token-4',
        rawApiResponseJson: '{}',
      }),
      /Validation error/
    );
  });

  await test('invalid inbox processing state rejected', async () => {
    await assert.rejects(
      GooglePubSubNotificationInbox.create({
        environment: 'test',
        pubsubMessageId: 'msg-3',
        rawPayloadJson: '{}',
        processingState: 'done',
      }),
      /Validation error/
    );
  });

  await test('missing required transaction fields rejected', async () => {
    await assert.rejects(
      GooglePlaySubscriptionTransaction.create({
        studioId: studio.id,
        environment: 'test',
        packageName: null,
        productId: 'basic_product',
        purchaseToken: 'purchase-token-5',
        rawApiResponseJson: '{}',
      }),
      /notNull Violation|Validation error/
    );
  });

  await test('missing required inbox fields rejected', async () => {
    await assert.rejects(
      GooglePubSubNotificationInbox.create({
        environment: 'test',
        rawPayloadJson: '{}',
      }),
      /notNull Violation|Validation error/
    );
  });

  await test('metadata environments and states are constrained', async () => {
    assert.deepStrictEqual(gpMeta.GOOGLE_PLAY_ENVIRONMENTS, ['test', 'production']);
    assert.ok(gpMeta.GOOGLE_PLAY_SUPPORTED_SUBSCRIPTION_STATES.includes('SUBSCRIPTION_STATE_ACTIVE'));
  });

  await test('product mapping basic and pro works', async () => {
    const config = {
      packageName: 'com.example.app',
      basicProductId: 'basic_product',
      basicBasePlanId: 'basic_monthly',
      proProductId: 'pro_product',
      proBasePlanId: 'pro_monthly',
      proOfferId: 'pro-offer',
    };

    assert.strictEqual(gpMeta.getGooglePlayProductPlan({ productId: 'basic_product', basePlanId: 'basic_monthly' }, config), 'basic');
    assert.strictEqual(gpMeta.getGooglePlayProductPlan({ productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'pro-offer' }, config), 'pro');
    assert.strictEqual(gpMeta.getGooglePlayProductPlan({ productId: 'pro_product', basePlanId: 'pro_monthly', offerId: 'wrong' }, config), null);
  });

  await test('duplicate basic/pro mapping configuration is rejected', async () => {
    const validation = gpMeta.validateGooglePlayProductConfiguration({
      packageName: 'com.example.app',
      basicProductId: 'shared',
      basicBasePlanId: 'monthly',
      proProductId: 'shared',
      proBasePlanId: 'monthly',
    }, { requireConfigured: true });

    assert.strictEqual(validation.isValid, false);
  });

  await test('unknown product or base plan is rejected', async () => {
    const config = {
      packageName: 'com.example.app',
      basicProductId: 'basic_product',
      basicBasePlanId: 'basic_monthly',
      proProductId: 'pro_product',
      proBasePlanId: 'pro_monthly',
    };

    assert.strictEqual(gpMeta.isAllowedGooglePlayProduct({ productId: 'x', basePlanId: 'basic_monthly' }, config), false);
    assert.strictEqual(gpMeta.isAllowedGooglePlayProduct({ productId: 'basic_product', basePlanId: 'x' }, config), false);
  });

  await test('account id generation is stable and secret-dependent', async () => {
    const s1 = gpService.generateGoogleObfuscatedAccountId({ studioId: 10, secret: 'secret-a' });
    const s1Again = gpService.generateGoogleObfuscatedAccountId({ studioId: 10, secret: 'secret-a' });
    const s2 = gpService.generateGoogleObfuscatedAccountId({ studioId: 11, secret: 'secret-a' });
    const s3 = gpService.generateGoogleObfuscatedAccountId({ studioId: 10, secret: 'secret-b' });

    assert.strictEqual(s1, s1Again);
    assert.notStrictEqual(s1, s2);
    assert.notStrictEqual(s1, s3);
    assert.strictEqual(s1.length, gpService.GOOGLE_PLAY_OBFUSCATED_ACCOUNT_ID_LENGTH);
    assert.strictEqual(gpService.isValidGoogleObfuscatedAccountId(s1), true);
    assert.strictEqual(s1.includes('10'), false);
  });

  await test('invalid hash inputs are rejected', async () => {
    assert.throws(() => gpService.generateGoogleObfuscatedAccountId({ studioId: 0, secret: 'x' }));
    assert.throws(() => gpService.generateGoogleObfuscatedAccountId({ studioId: 1, secret: '' }));
    assert.throws(() => gpService.generateGoogleObfuscatedProfileId({ studioId: 1, userId: 0, secret: 'x' }));
  });

  await test('purchase intent validation is in-memory and strict', async () => {
    const accountId = gpService.generateGoogleObfuscatedAccountId({ studioId: 1, secret: 's' });
    const baseIntent = {
      studioId: 1,
      provider: 'google_play',
      targetPlan: 'basic',
      status: 'created',
      expiresAt: new Date(Date.now() + 60 * 1000),
      consumedAt: null,
      googleObfuscatedAccountId: accountId,
    };

    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification(baseIntent, { studioId: 1 }).isValid, true);
    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification({ ...baseIntent, provider: 'apple' }, { studioId: 1 }).isValid, false);
    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification({ ...baseIntent, targetPlan: 'enterprise' }, { studioId: 1 }).isValid, false);
    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification({ ...baseIntent, status: 'verified' }, { studioId: 1 }).isValid, false);
    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification({ ...baseIntent, consumedAt: new Date() }, { studioId: 1 }).isValid, false);
    assert.strictEqual(gpService.validateGooglePlayPurchaseIntentForVerification({ ...baseIntent, studioId: 2 }, { studioId: 1 }).isValid, false);
  });

  await test('googleapis CJS import and subscriptionsv2.get existence', async () => {
    const { google } = require('googleapis');
    const androidpublisher = google.androidpublisher('v3');
    assert.ok(androidpublisher.purchases.subscriptionsv2);
    assert.strictEqual(typeof androidpublisher.purchases.subscriptionsv2.get, 'function');
  });

  await test('Google client import has no credential side-effects', async () => {
    assert.ok(gpClient);
    assert.strictEqual(typeof gpClient.createGooglePlayDeveloperClient, 'function');
  });

  await test('Google client explicit missing package name is rejected', async () => {
    await assert.rejects(
      Promise.resolve().then(() => gpClient.createGooglePlayDeveloperClient({ config: {
        serviceAccountJson: JSON.stringify({ client_email: 'a@b', private_key: 'key' }),
      } })),
      (error) => error && error.code === 'GOOGLE_PLAY_PACKAGE_NAME_REQUIRED'
    );
  });

  await test('Google client explicit missing credentials is rejected', async () => {
    await assert.rejects(
      Promise.resolve().then(() => gpClient.createGooglePlayDeveloperClient({ config: {
        packageName: 'com.example.app',
      } })),
      (error) => error && error.code === 'GOOGLE_PLAY_SERVICE_ACCOUNT_REQUIRED'
    );
  });

  await test('Google client invalid inline JSON is rejected', async () => {
    await assert.rejects(
      Promise.resolve().then(() => gpClient.createGooglePlayDeveloperClient({ config: {
        packageName: 'com.example.app',
        serviceAccountJson: '{bad-json',
      } })),
      (error) => error && error.code === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_INVALID'
    );
  });

  await test('Google client unreadable credential path is rejected', async () => {
    await assert.rejects(
      Promise.resolve().then(() => gpClient.createGooglePlayDeveloperClient({ config: {
        packageName: 'com.example.app',
        serviceAccountPath: path.join(tmpRoot, 'missing.json'),
      } })),
      (error) => error && error.code === 'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_READ_FAILED'
    );
  });

  await test('Google client ambiguity between inline/path is rejected', async () => {
    await assert.rejects(
      Promise.resolve().then(() => gpClient.createGooglePlayDeveloperClient({ config: {
        packageName: 'com.example.app',
        serviceAccountJson: JSON.stringify({ client_email: 'a@b', private_key: 'key' }),
        serviceAccountPath: path.join(tmpRoot, 'x.json'),
      } })),
      (error) => error && error.code === 'GOOGLE_PLAY_SERVICE_ACCOUNT_SOURCE_AMBIGUOUS'
    );
  });

  await test('Google client can be explicitly constructed without API call', async () => {
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
              get: () => {
                throw new Error('should not be called');
              },
            },
          },
        };
      },
    };

    const created = gpClient.createGooglePlayDeveloperClient({
      environment: 'test',
      config: {
        packageName: 'com.example.app',
        serviceAccountJson: JSON.stringify({
          client_email: 'svc@example.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
          project_id: 'my-project',
        }),
      },
    }, {
      google: fakeGoogle,
      GoogleAuthCtor: fakeGoogle.auth.GoogleAuth,
      androidPublisherFactory: fakeGoogle.androidpublisher,
    });

    assert.strictEqual(created.environment, 'test');
    assert.strictEqual(created.config.packageName, 'com.example.app');
    assert.strictEqual(created.scope, gpClient.ANDROID_PUBLISHER_SCOPE);
  });

  const mappingConfig = {
    packageName: 'com.example.app',
    basicProductId: 'basic_product',
    basicBasePlanId: 'basic_monthly',
    basicOfferId: 'trial-offer',
    proProductId: 'pro_product',
    proBasePlanId: 'pro_monthly',
  };

  const expectedAccountId = gpService.generateGoogleObfuscatedAccountId({ studioId: 1, secret: 'phase318-secret' });

  function makeResponse(overrides = {}) {
    return {
      kind: 'androidpublisher#subscriptionPurchaseV2',
      regionCode: 'TR',
      startTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      linkedPurchaseToken: 'old-purchase-token',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      externalAccountIdentifiers: {
        obfuscatedExternalAccountId: expectedAccountId,
      },
      lineItems: [
        {
          productId: 'basic_product',
          expiryTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          latestSuccessfulOrderId: 'GPA.1',
          autoRenewingPlan: {
            autoRenewEnabled: true,
          },
          offerDetails: {
            basePlanId: 'basic_monthly',
            offerId: 'trial-offer',
            offerTags: ['intro'],
          },
          offerPhase: {
            freeTrial: {},
          },
          deferredItemReplacement: null,
          signupPromotion: null,
        },
      ],
      ...overrides,
    };
  }

  await test('line items extracted safely', async () => {
    const response = makeResponse({ lineItems: [
      { productId: '', expiryTime: null },
      makeResponse().lineItems[0],
    ] });
    const lineItems = gpService.extractGooglePlaySubscriptionLineItems(response);
    assert.strictEqual(lineItems.length, 1);
    assert.strictEqual(lineItems[0].productId, 'basic_product');
  });

  await test('effective line item selection uses expiry, not input order', async () => {
    const now = new Date();
    const response = makeResponse({
      lineItems: [
        {
          productId: 'basic_product',
          expiryTime: new Date(now.getTime() + 60 * 1000).toISOString(),
          offerDetails: { basePlanId: 'basic_monthly', offerId: 'trial-offer' },
          autoRenewingPlan: { autoRenewEnabled: true },
        },
        {
          productId: 'basic_product',
          expiryTime: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
          offerDetails: { basePlanId: 'basic_monthly', offerId: 'trial-offer' },
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    });

    const selected = gpService.selectEffectiveGooglePlayLineItem(response, now);
    assert.ok(selected && selected.expiryTime);
    assert.strictEqual(selected.expiryTime.toISOString(), new Date(now.getTime() + 2 * 60 * 1000).toISOString());
  });

  await test('providerSubscriptionId remains purchaseToken', async () => {
    const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse(),
      purchaseToken: 'current-token',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      environment: 'production',
      now: new Date(),
    });

    assert.strictEqual(mapped.ok, true);
    assert.strictEqual(mapped.value.providerSubscriptionId, 'current-token');
    assert.strictEqual(mapped.value.latestSuccessfulOrderId, 'GPA.1');
  });

  await test('linkedPurchaseToken extraction and replacement helper behavior', async () => {
    const response = makeResponse({ linkedPurchaseToken: 'old-token' });
    assert.strictEqual(gpService.getGoogleLinkedPurchaseToken(response), 'old-token');
    assert.strictEqual(gpService.isGoogleReplacementTransition(response), true);

    const valid = gpService.validateGooglePurchaseTokenLineage({
      currentPurchaseToken: 'new-token',
      linkedPurchaseToken: 'old-token',
      existingBinding: 'old-token',
    });
    assert.strictEqual(valid.isValid, true);
    assert.strictEqual(valid.requiresRebind, true);

    const invalid = gpService.validateGooglePurchaseTokenLineage({
      currentPurchaseToken: 'new-token',
      linkedPurchaseToken: 'other-old-token',
      existingBinding: 'old-token',
    });
    assert.strictEqual(invalid.isValid, false);
  });

  await test('environment mapping from testPurchase and mismatch rejection', async () => {
    const testMapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({ testPurchase: {} }),
      purchaseToken: 'test-token',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      environment: 'test',
      now: new Date(),
    });
    assert.strictEqual(testMapped.ok, true);
    assert.strictEqual(testMapped.value.environment, 'test');

    const mismatch = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({ testPurchase: {} }),
      purchaseToken: 'test-token',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      environment: 'production',
      now: new Date(),
    });
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(mismatch.code, 'GOOGLE_PLAY_ENVIRONMENT_MISMATCH');
  });

  await test('account identifier missing or mismatched is rejected', async () => {
    const missing = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({ externalAccountIdentifiers: null }),
      purchaseToken: 'token',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.code, 'GOOGLE_PLAY_ACCOUNT_ID_MISSING');

    const mismatch = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({ externalAccountIdentifiers: { obfuscatedExternalAccountId: 'abc' } }),
      purchaseToken: 'token',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(mismatch.code, 'GOOGLE_PLAY_ACCOUNT_ID_MISMATCH');
  });

  await test('status mapping aligns with official SubscriptionState', async () => {
    const now = new Date();
    const states = [
      ['SUBSCRIPTION_STATE_PENDING', 'pending'],
      ['SUBSCRIPTION_STATE_ACTIVE', 'trialing'],
      ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'grace_period'],
      ['SUBSCRIPTION_STATE_ON_HOLD', 'billing_retry'],
      ['SUBSCRIPTION_STATE_PAUSED', 'paused'],
      ['SUBSCRIPTION_STATE_EXPIRED', 'expired'],
      ['SUBSCRIPTION_STATE_CANCELED', 'cancelled'],
      ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'cancelled'],
    ];

    for (const [state, expected] of states) {
      const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
        response: makeResponse({
          subscriptionState: state,
          lineItems: [
            {
              productId: 'basic_product',
              expiryTime: new Date(now.getTime() + 3600 * 1000).toISOString(),
              autoRenewingPlan: { autoRenewEnabled: false },
              offerDetails: { basePlanId: 'basic_monthly', offerId: 'trial-offer' },
              offerPhase: state === 'SUBSCRIPTION_STATE_ACTIVE' ? { freeTrial: {} } : { basePrice: {} },
            },
          ],
        }),
        purchaseToken: 'tok',
        expectedPackageName: 'com.example.app',
        expectedObfuscatedAccountId: expectedAccountId,
        config: mappingConfig,
        now,
      });

      assert.strictEqual(mapped.ok, true);
      assert.strictEqual(mapped.value.normalizedStatus, expected);
    }
  });

  await test('cancelled with remaining period is not treated as expired', async () => {
    const now = new Date();
    const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        lineItems: [
          {
            productId: 'pro_product',
            expiryTime: new Date(now.getTime() + 3 * 24 * 3600 * 1000).toISOString(),
            autoRenewingPlan: { autoRenewEnabled: false },
            offerDetails: { basePlanId: 'pro_monthly' },
            offerPhase: { basePrice: {} },
          },
        ],
      }),
      purchaseToken: 'tok-cancel',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now,
    });

    assert.strictEqual(mapped.ok, true);
    assert.strictEqual(mapped.value.normalizedStatus, 'cancelled');
  });

  await test('active without freeTrial evidence maps to active, not trialing', async () => {
    const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({
        lineItems: [{
          productId: 'pro_product',
          expiryTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: true },
          offerDetails: { basePlanId: 'pro_monthly' },
          signupPromotion: { vanityCode: { promotionCode: 'WELCOME' } },
          offerPhase: { basePrice: {} },
        }],
      }),
      purchaseToken: 'tok-no-trial',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });

    assert.strictEqual(mapped.ok, true);
    assert.strictEqual(mapped.value.normalizedStatus, 'active');
  });

  await test('autoRenewEnabled maps only from autoRenewingPlan when present', async () => {
    const withAutoRenew = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({
        lineItems: [{
          productId: 'pro_product',
          expiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: false },
          offerDetails: { basePlanId: 'pro_monthly' },
          offerPhase: { basePrice: {} },
        }],
      }),
      purchaseToken: 'tok-renew-a',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });

    assert.strictEqual(withAutoRenew.ok, true);
    assert.strictEqual(withAutoRenew.value.autoRenewEnabled, false);

    const withoutAutoRenew = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({
        lineItems: [{
          productId: 'pro_product',
          expiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          offerDetails: { basePlanId: 'pro_monthly' },
          offerPhase: { basePrice: {} },
        }],
      }),
      purchaseToken: 'tok-renew-b',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });

    assert.strictEqual(withoutAutoRenew.ok, true);
    assert.strictEqual(withoutAutoRenew.value.autoRenewEnabled, null);
  });

  await test('mapping unknown plan combination is rejected', async () => {
    const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse({
        lineItems: [{
          productId: 'unknown',
          expiryTime: new Date(Date.now() + 3600 * 1000).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: true },
          offerDetails: { basePlanId: 'unknown' },
          offerPhase: { basePrice: {} },
        }],
      }),
      purchaseToken: 'tok-unknown',
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });

    assert.strictEqual(mapped.ok, false);
    assert.strictEqual(mapped.code, 'GOOGLE_PLAY_PRODUCT_MAPPING_INVALID');
  });

  await test('pure mapping helper performs no DB writes', async () => {
    const beforeTx = await GooglePlaySubscriptionTransaction.count();
    const beforeInbox = await GooglePubSubNotificationInbox.count();

    const mapped = gpService.mapGooglePlaySubscriptionV2ToEntitlementInput({
      response: makeResponse(),
      purchaseToken: compactJwsLikeToken('pure-map'),
      expectedPackageName: 'com.example.app',
      expectedObfuscatedAccountId: expectedAccountId,
      config: mappingConfig,
      now: new Date(),
    });

    assert.strictEqual(mapped.ok, true);

    const afterTx = await GooglePlaySubscriptionTransaction.count();
    const afterInbox = await GooglePubSubNotificationInbox.count();
    assert.strictEqual(beforeTx, afterTx);
    assert.strictEqual(beforeInbox, afterInbox);
  });

  await test('existing provider-neutral state remains unchanged', async () => {
    const state = await Studio.findByPk(studio.id);
    assert.strictEqual(typeof state.subscriptionStatus, 'string');
    assert.strictEqual(typeof state.subscriptionPlan, 'string');
    assert.strictEqual(normalizeDate(state.trialEndsAt), null);
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
