const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Op } = require('sequelize');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase319-'));
  const dbPath = path.join(tmpRoot, 'validation.sqlite');

  process.env.DB_PATH = dbPath;

  const {
    sequelize,
    Studio,
    User,
    SubscriptionPurchaseIntent,
    StudioSubscriptionEntitlement,
    GooglePlaySubscriptionTransaction,
    GooglePubSubNotificationInbox,
    AppleSubscriptionTransaction,
    AppleServerNotificationInbox,
  } = require('../models');

  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureGooglePlaySubscriptionTransactionsTable = require('../ensureGooglePlaySubscriptionTransactionsTable');
  const ensureGooglePubSubNotificationInboxTable = require('../ensureGooglePubSubNotificationInboxTable');

  const subscriptionService = require('../services/subscriptionService');
  const googleSubscriptionService = require('../services/googlePlaySubscriptionService');
  const googlePurchaseIntentService = require('../services/googlePlayPurchaseIntentService');
  const subscriptionController = require('../controllers/subscriptionController');

  const report = {
    disposableDbPath: dbPath,
    testsPassed: [],
    testsFailed: [],
  };

  const BASE_ENV = {
    GOOGLE_PLAY_ACCOUNT_HASH_SECRET: process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET,
    GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES: process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES,
  };

  function restoreGoogleEnv() {
    if (typeof BASE_ENV.GOOGLE_PLAY_ACCOUNT_HASH_SECRET === 'undefined') {
      delete process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
    } else {
      process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = BASE_ENV.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
    }

    if (typeof BASE_ENV.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES === 'undefined') {
      delete process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
    } else {
      process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = BASE_ENV.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
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
      restoreGoogleEnv();
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

  let studioCounter = 10;
  async function createStudioWithAdmin({ label, subscriptionStatus = 'trial', subscriptionPlan = 'trial', trialEndsAt = null }) {
    const studioCode = `s${studioCounter}`;
    studioCounter += 1;
    const studio = await Studio.create({
      name: `Studio ${label}`,
      studioCode,
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
      username: `user_${studioCode}`,
      password: 'x',
      role: 'admin',
      assignedSalonIds: [],
      permissions: [],
      studioId: studio.id,
    });

    return { studio, user };
  }

  function assertSafePurchaseIntentResponse(payload) {
    assert.ok(payload && typeof payload === 'object');
    assert.ok(payload.purchaseIntent && typeof payload.purchaseIntent === 'object');

    const keys = Object.keys(payload.purchaseIntent).sort();
    assert.deepStrictEqual(keys, ['expiresAt', 'id', 'obfuscatedAccountId', 'plan', 'provider']);
  }

  await bootstrap();
  await bootstrap();

  await test('startup bootstrap succeeds without Google intent env values', async () => {
    delete process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
    delete process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
    await ensureSubscriptionPurchaseIntentsTable();
  });

  await test('helper supports 64-char obfuscated account ids', async () => {
    const id = googleSubscriptionService.generateGoogleObfuscatedAccountId({
      studioId: 1,
      secret: 'x'.repeat(32),
    });
    assert.strictEqual(id.length, 64);
    assert.strictEqual(googleSubscriptionService.isValidGoogleObfuscatedAccountId(id), true);
  });

  await test('endpoint requires authentication context', async () => {
    const req = { body: { plan: 'basic' } };
    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent(req, res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('invalid plan variants are rejected with 400', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'invalid-plan' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'y'.repeat(32);

    const invalidPlans = ['trial', 'enterprise', 'lifetime', 'unknown', '', null, 3, {}, []];

    for (const candidate of invalidPlans) {
      const req = {
        user: { studioId: studio.id, id: user.id },
        body: { plan: candidate },
      };
      const res = makeRes();
      await subscriptionController.createGooglePlayPurchaseIntent(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.payload, { error: 'INVALID_SUBSCRIPTION_PLAN' });
    }
  });

  await test('authenticated Basic request succeeds with safe response shape', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'basic-success' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'a'.repeat(32);

    const req = {
      user: { studioId: studio.id, id: user.id },
      body: {
        plan: 'basic',
        studioId: 999,
        userId: 999,
        provider: 'apple',
        purchaseToken: 'bad',
        expiresAt: '2030-01-01T00:00:00.000Z',
        googleObfuscatedAccountId: 'override',
      },
    };
    const res = makeRes();

    await subscriptionController.createGooglePlayPurchaseIntent(req, res);

    assert.strictEqual(res.statusCode, 201);
    assertSafePurchaseIntentResponse(res.payload);
    assert.strictEqual(res.payload.purchaseIntent.provider, 'google_play');
    assert.strictEqual(res.payload.purchaseIntent.plan, 'basic');

    const createdRow = await SubscriptionPurchaseIntent.findByPk(res.payload.purchaseIntent.id);
    assert.ok(createdRow);
    assert.strictEqual(createdRow.studioId, studio.id);
    assert.strictEqual(createdRow.provider, 'google_play');
    assert.strictEqual(createdRow.targetPlan, 'basic');
    assert.strictEqual(createdRow.appAccountToken, null);
    assert.strictEqual(createdRow.googleObfuscatedProfileId, null);
    assert.strictEqual(createdRow.status, 'created');
    assert.strictEqual(createdRow.consumedAt, null);
    assert.strictEqual(createdRow.createdByUserId, user.id);
    assert.strictEqual(createdRow.metadataJson, null);
  });

  await test('authenticated Pro request succeeds and ignores body ownership fields', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'pro-success' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'b'.repeat(32);

    const req = {
      user: { studioId: studio.id, id: user.id },
      body: {
        plan: 'pro',
        provider: 'google_play',
        studioId: 2,
      },
    };
    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent(req, res);

    assert.strictEqual(res.statusCode, 201);
    assertSafePurchaseIntentResponse(res.payload);
    assert.strictEqual(res.payload.purchaseIntent.plan, 'pro');
  });

  await test('createdByUserId is null when authenticated user id is unavailable', async () => {
    const { studio } = await createStudioWithAdmin({ label: 'no-user-id' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'c'.repeat(32);

    const req = {
      user: { studioId: studio.id },
      body: { plan: 'basic' },
    };
    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent(req, res);

    assert.strictEqual(res.statusCode, 201);
    const row = await SubscriptionPurchaseIntent.findByPk(res.payload.purchaseIntent.id);
    assert.strictEqual(row.createdByUserId, null);
  });

  await test('secret is required and weak secrets are rejected with sanitized config error', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'secret-invalid' });

    delete process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET;
    let res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.payload, { error: 'GOOGLE_PLAY_ACCOUNT_CONFIGURATION_FAILED' });

    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = '   ';
    res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.payload, { error: 'GOOGLE_PLAY_ACCOUNT_CONFIGURATION_FAILED' });

    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'short-secret';
    res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.payload, { error: 'GOOGLE_PLAY_ACCOUNT_CONFIGURATION_FAILED' });
  });

  await test('TTL default and bounds work with controlled failure for invalid values', async () => {
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'd'.repeat(32);

    delete process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES;
    assert.strictEqual(googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), 15);

    process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = '5';
    assert.strictEqual(googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), 5);

    process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = '60';
    assert.strictEqual(googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), 60);

    process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = 'abc';
    assert.throws(() => googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), (error) => error.code === 'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED');

    process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = '4';
    assert.throws(() => googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), (error) => error.code === 'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED');

    process.env.GOOGLE_PLAY_PURCHASE_INTENT_TTL_MINUTES = '61';
    assert.throws(() => googlePurchaseIntentService.resolveGooglePlayPurchaseIntentTtlMinutes(), (error) => error.code === 'GOOGLE_PLAY_PURCHASE_INTENT_CREATION_FAILED');
  });

  await test('obfuscatedAccountId is deterministic per studio+secret and changes with secret/studio', async () => {
    const secret = 'e'.repeat(32);
    const one = googleSubscriptionService.generateGoogleObfuscatedAccountId({ studioId: 12345, secret });
    const oneAgain = googleSubscriptionService.generateGoogleObfuscatedAccountId({ studioId: 12345, secret });
    const otherStudio = googleSubscriptionService.generateGoogleObfuscatedAccountId({ studioId: 67890, secret });
    const otherSecret = googleSubscriptionService.generateGoogleObfuscatedAccountId({ studioId: 12345, secret: 'f'.repeat(32) });

    assert.strictEqual(one, oneAgain);
    assert.notStrictEqual(one, otherStudio);
    assert.notStrictEqual(one, otherSecret);
    assert.strictEqual(one.includes('12345'), false);
  });

  await test('replacement behavior expires older created Google intents only', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'replace' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'g'.repeat(32);

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);

    const created = await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'google_play',
      targetPlan: 'basic',
      appAccountToken: null,
      googleObfuscatedAccountId: 'a'.repeat(64),
      googleObfuscatedProfileId: null,
      status: 'created',
      expiresAt: future,
      consumedAt: null,
      createdByUserId: user.id,
      metadataJson: null,
    });

    const verified = await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'google_play',
      targetPlan: 'pro',
      appAccountToken: null,
      googleObfuscatedAccountId: 'c'.repeat(64),
      googleObfuscatedProfileId: null,
      status: 'verified',
      expiresAt: future,
      consumedAt: null,
      createdByUserId: user.id,
      metadataJson: null,
    });

    const appleIntent = await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'apple',
      targetPlan: 'basic',
      appAccountToken: `token-apple-${studio.id}`,
      googleObfuscatedAccountId: null,
      googleObfuscatedProfileId: null,
      status: 'started',
      expiresAt: future,
      consumedAt: null,
      createdByUserId: user.id,
      metadataJson: null,
    });

    const alreadyExpired = await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'google_play',
      targetPlan: 'pro',
      appAccountToken: null,
      googleObfuscatedAccountId: 'd'.repeat(64),
      googleObfuscatedProfileId: null,
      status: 'expired',
      expiresAt: past,
      consumedAt: null,
      createdByUserId: user.id,
      metadataJson: null,
    });

    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'pro' } }, res);

    assert.strictEqual(res.statusCode, 201);

    await created.reload();
    await verified.reload();
    await appleIntent.reload();
    await alreadyExpired.reload();

    assert.strictEqual(created.status, 'expired');
    assert.strictEqual(verified.status, 'verified');
    assert.strictEqual(appleIntent.status, 'started');
    assert.strictEqual(alreadyExpired.status, 'expired');

    const reusableGoogleCount = await SubscriptionPurchaseIntent.count({
      where: {
        studioId: studio.id,
        provider: 'google_play',
        status: { [Op.in]: ['created', 'started'] },
      },
    });
    assert.strictEqual(reusableGoogleCount, 1);
  });

  await test('replacement behavior expires older started Google intents only', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'replace-started' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'g'.repeat(32);

    const future = new Date(Date.now() + 60 * 60 * 1000);

    const started = await SubscriptionPurchaseIntent.create({
      studioId: studio.id,
      provider: 'google_play',
      targetPlan: 'basic',
      appAccountToken: null,
      googleObfuscatedAccountId: 'b'.repeat(64),
      googleObfuscatedProfileId: null,
      status: 'started',
      expiresAt: future,
      consumedAt: null,
      createdByUserId: user.id,
      metadataJson: null,
    });

    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);

    assert.strictEqual(res.statusCode, 201);
    await started.reload();
    assert.strictEqual(started.status, 'expired');

    const reusableGoogleCount = await SubscriptionPurchaseIntent.count({
      where: {
        studioId: studio.id,
        provider: 'google_play',
        status: { [Op.in]: ['created', 'started'] },
      },
    });
    assert.strictEqual(reusableGoogleCount, 1);
  });

  await test('concurrent Google requests keep one reusable intent and avoid raw errors', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'concurrency' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'h'.repeat(32);

    const reqFactory = () => ({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } });

    const resA = makeRes();
    const resB = makeRes();

    await Promise.all([
      subscriptionController.createGooglePlayPurchaseIntent(reqFactory(), resA),
      subscriptionController.createGooglePlayPurchaseIntent(reqFactory(), resB),
    ]);

    assert.ok([201, 500, 409].includes(resA.statusCode));
    assert.ok([201, 500, 409].includes(resB.statusCode));
    if (resA.statusCode !== 201) {
      assert.notStrictEqual(resA.payload && resA.payload.error, 'SequelizeUniqueConstraintError');
    }
    if (resB.statusCode !== 201) {
      assert.notStrictEqual(resB.payload && resB.payload.error, 'SequelizeUniqueConstraintError');
    }

    const reusableGoogleCount = await SubscriptionPurchaseIntent.count({
      where: {
        studioId: studio.id,
        provider: 'google_play',
        status: { [Op.in]: ['created', 'started'] },
      },
    });
    assert.strictEqual(reusableGoogleCount, 1);
  });

  await test('different studios can create intents independently', async () => {
    const a = await createStudioWithAdmin({ label: 'independent-a' });
    const b = await createStudioWithAdmin({ label: 'independent-b' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'i'.repeat(32);

    const resA = makeRes();
    const resB = makeRes();

    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: a.studio.id, id: a.user.id }, body: { plan: 'basic' } }, resA);
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: b.studio.id, id: b.user.id }, body: { plan: 'pro' } }, resB);

    assert.strictEqual(resA.statusCode, 201);
    assert.strictEqual(resB.statusCode, 201);
  });

  await test('effective entitlement conflict blocks creation by provider', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'entitlement-conflict' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'j'.repeat(32);

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'x',
      providerSubscriptionId: 'gp-1',
      sourceLastUpdate: 'verify_endpoint',
      environment: 'test',
    });

    let res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.payload, { error: 'GOOGLE_PLAY_ENTITLEMENT_ALREADY_ACTIVE' });

    await StudioSubscriptionEntitlement.destroy({ where: { studioId: studio.id } });

    await StudioSubscriptionEntitlement.create({
      studioId: studio.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'grace_period',
      providerProductId: 'x',
      providerSubscriptionId: 'ap-1',
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
    });

    res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.payload, { error: 'OTHER_PROVIDER_ENTITLEMENT_ACTIVE' });
  });

  await test('non-effective statuses do not block and legacy trial does not block', async () => {
    const { studio, user } = await createStudioWithAdmin({
      label: 'non-effective',
      subscriptionStatus: 'trial',
      subscriptionPlan: 'trial',
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'k'.repeat(32);

    for (const row of [
      { provider: 'google_play', normalizedStatus: 'expired', environment: 'production', providerSubscriptionId: 'x1' },
      { provider: 'google_play', normalizedStatus: 'cancelled', environment: 'production', providerSubscriptionId: 'x2' },
      { provider: 'google_play', normalizedStatus: 'refunded', environment: 'production', providerSubscriptionId: 'x3' },
      { provider: 'apple', normalizedStatus: 'revoked', environment: 'sandbox', providerSubscriptionId: 'x4' },
    ]) {
      await StudioSubscriptionEntitlement.create({
        studioId: studio.id,
        provider: row.provider,
        plan: 'basic',
        normalizedStatus: row.normalizedStatus,
        providerProductId: 'prod',
        providerSubscriptionId: row.providerSubscriptionId,
        sourceLastUpdate: 'verify_endpoint',
        environment: row.environment,
      });
    }

    const beforeStudio = await Studio.findByPk(studio.id);
    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);

    assert.strictEqual(res.statusCode, 201);

    const afterStudio = await Studio.findByPk(studio.id);
    assert.strictEqual(afterStudio.subscriptionStatus, beforeStudio.subscriptionStatus);
    assert.strictEqual(afterStudio.subscriptionPlan, beforeStudio.subscriptionPlan);
    assert.strictEqual(
      afterStudio.trialEndsAt ? afterStudio.trialEndsAt.toISOString() : null,
      beforeStudio.trialEndsAt ? beforeStudio.trialEndsAt.toISOString() : null
    );
  });

  await test('response does not expose internal fields', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'safe-response' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'l'.repeat(32);

    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'pro' } }, res);

    assert.strictEqual(res.statusCode, 201);
    assertSafePurchaseIntentResponse(res.payload);

    const asJson = JSON.stringify(res.payload);
    assert.strictEqual(asJson.includes('studioId'), false);
    assert.strictEqual(asJson.includes('createdByUserId'), false);
    assert.strictEqual(asJson.includes('googleObfuscatedProfileId'), false);
    assert.strictEqual(asJson.includes('metadataJson'), false);
    assert.strictEqual(asJson.includes('status'), false);
    assert.strictEqual(asJson.includes('GOOGLE_PLAY_ACCOUNT_HASH_SECRET'), false);
  });

  await test('service-level plan validator remains provider-neutral helper', async () => {
    assert.strictEqual(subscriptionService.isValidProviderBackedPlan('basic'), true);
    assert.strictEqual(subscriptionService.isValidProviderBackedPlan('pro'), true);
    assert.strictEqual(subscriptionService.isValidProviderBackedPlan('trial'), false);
  });

  await test('no entitlement/transaction/pubsub side effects on intent creation', async () => {
    const { studio, user } = await createStudioWithAdmin({ label: 'no-side-effects' });
    process.env.GOOGLE_PLAY_ACCOUNT_HASH_SECRET = 'm'.repeat(32);

    const beforeEntitlements = await StudioSubscriptionEntitlement.count();
    const beforeGoogleTx = await GooglePlaySubscriptionTransaction.count();
    const beforeGoogleInbox = await GooglePubSubNotificationInbox.count();
    const beforeAppleTx = await AppleSubscriptionTransaction.count();
    const beforeAppleInbox = await AppleServerNotificationInbox.count();

    const res = makeRes();
    await subscriptionController.createGooglePlayPurchaseIntent({ user: { studioId: studio.id, id: user.id }, body: { plan: 'basic' } }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(await StudioSubscriptionEntitlement.count(), beforeEntitlements);
    assert.strictEqual(await GooglePlaySubscriptionTransaction.count(), beforeGoogleTx);
    assert.strictEqual(await GooglePubSubNotificationInbox.count(), beforeGoogleInbox);
    assert.strictEqual(await AppleSubscriptionTransaction.count(), beforeAppleTx);
    assert.strictEqual(await AppleServerNotificationInbox.count(), beforeAppleInbox);
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
