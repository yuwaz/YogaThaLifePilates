const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const createdTempPaths = [];

function makeCompactJwsToken(name) {
  const safe = String(name || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${safe || 'x'}.payload.signature`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addDays(baseDate, days) {
  return new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
}

function subDays(baseDate, days) {
  return new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase317v-'));
  createdTempPaths.push(tmpRoot);
  const dbPath = path.join(tmpRoot, 'validation.sqlite');

  process.env.DB_PATH = dbPath;
  process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_BASIC = 'com.example.basic.sandbox';
  process.env.APPLE_IAP_ALLOWED_PRODUCT_IDS_PRO = 'com.example.pro.sandbox';
  process.env.APPLE_IAP_BUNDLE_ID = 'com.example.yogatha';
  process.env.APPLE_IAP_APPLE_APP_ID = '123456789';
  process.env.APPLE_IAP_ENVIRONMENTS_ALLOWED = 'sandbox,production';
  process.env.APPLE_NOTIFICATION_MAX_ATTEMPTS = '3';

  const {
    sequelize,
    Studio,
    User,
    StudioSubscriptionEntitlement,
    AppleSubscriptionTransaction,
    AppleServerNotificationInbox,
  } = require('../models');

  const ensureStudiosTable = require('../ensureStudiosTable');
  const ensureStudioSubscriptionEntitlementsTable = require('../ensureStudioSubscriptionEntitlementsTable');
  const ensureSubscriptionPurchaseIntentsTable = require('../ensureSubscriptionPurchaseIntentsTable');
  const ensureAppleSubscriptionTransactionsTable = require('../ensureAppleSubscriptionTransactionsTable');
  const ensureAppleServerNotificationInboxTable = require('../ensureAppleServerNotificationInboxTable');
  const ensureStudioCodeColumn = require('../ensureStudioCodeColumn');
  const ensureStudioOnboardingColumns = require('../ensureStudioOnboardingColumns');
  const ensureUserStudioIdColumn = require('../ensureUserStudioIdColumn');
  const ensureMemberStudioIdColumn = require('../ensureMemberStudioIdColumn');
  const ensureSalonStudioIdColumn = require('../ensureSalonStudioIdColumn');
  const ensureMemberTypeStudioIdColumn = require('../ensureMemberTypeStudioIdColumn');
  const ensureLessonPackageStudioIdColumn = require('../ensureLessonPackageStudioIdColumn');
  const ensurePaymentMethodStudioIdColumn = require('../ensurePaymentMethodStudioIdColumn');
  const ensureEquipmentStudioIdColumn = require('../ensureEquipmentStudioIdColumn');
  const ensureExpenseStudioIdColumn = require('../ensureExpenseStudioIdColumn');
  const ensurePaymentStudioIdColumn = require('../ensurePaymentStudioIdColumn');
  const ensureReservationStudioIdColumn = require('../ensureReservationStudioIdColumn');
  const ensureAttendanceStudioIdColumn = require('../ensureAttendanceStudioIdColumn');
  const ensureMemberLessonPackageStudioIdColumn = require('../ensureMemberLessonPackageStudioIdColumn');
  const ensureManualCardUsagesTable = require('../ensureManualCardUsagesTable');
  const ensureMemberMeasurementStudioIdColumn = require('../ensureMemberMeasurementStudioIdColumn');
  const ensureMemberSoftDeleteColumns = require('../ensureMemberSoftDeleteColumns');
  const ensureAttendanceReservationColumn = require('../ensureAttendanceReservationColumn');
  const ensureAttendanceInstructorColumn = require('../ensureAttendanceInstructorColumn');
  const ensureMemberMeasurementsTable = require('../ensureMemberMeasurementsTable');
  const ensureStudioScopedUserMemberUniqueness = require('../ensureStudioScopedUserMemberUniqueness');
  const ensureInstructorPayoutAndSessionTypeColumns = require('../ensureInstructorPayoutAndSessionTypeColumns');

  const {
    reconcileAppleEntitlementById,
    reconcileAppleEntitlementsBatch,
    recoverAppleNotificationHistoryForEntitlement,
    retryDueFailedAppleNotificationInbox,
    AppleReconciliationError,
  } = require('../services/appleReconciliationService');

  const appleClientModule = require('../services/appleAppStoreServerClient');
  const verifierModule = require('../services/appleSignedDataVerifier');

  const report = {
    disposableDbPath: dbPath,
    bootstrap: {},
    testsPassed: [],
    testsFailed: [],
    defectsFixed: [
      'Added verifier dependency injection seams for reconciliation status/history decoding',
      'Added bounded history transaction count and pagination-stall/missing-revision guards',
      'Added notification recovery lookback/count bounds and pagination-stall/missing-token guards',
      'Added retry selection guard for max-attempt failed inbox rows',
      'Added batch selection filter/order for effective and recently expired entitlements',
      'Sanitized CLI output and added narrow harness dependency injection seam',
    ],
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

  function buildStubVerifiers(mapping) {
    const txCalls = [];
    const renewalCalls = [];

    async function verifyTransactionFn(signedTransactionInfo) {
      txCalls.push(signedTransactionInfo);
      const entry = mapping.transactions[signedTransactionInfo];
      if (!entry) {
        throw new Error('missing transaction mapping');
      }
      if (entry instanceof Error) {
        throw entry;
      }
      return clone(entry);
    }

    async function verifyRenewalFn(signedRenewalInfo) {
      renewalCalls.push(signedRenewalInfo);
      const entry = mapping.renewals[signedRenewalInfo];
      if (!entry) {
        throw new Error('missing renewal mapping');
      }
      if (entry instanceof Error) {
        throw entry;
      }
      return clone(entry);
    }

    return { verifyTransactionFn, verifyRenewalFn, txCalls, renewalCalls };
  }

  async function bootstrapLikeApp() {
    await sequelize.sync();
    await ensureStudiosTable();
    await ensureStudioSubscriptionEntitlementsTable();
    await ensureSubscriptionPurchaseIntentsTable();
    await ensureAppleSubscriptionTransactionsTable();
    await ensureAppleServerNotificationInboxTable();
    await ensureStudioCodeColumn();
    await ensureStudioOnboardingColumns();
    await ensureUserStudioIdColumn();
    await ensureMemberStudioIdColumn();
    await ensureSalonStudioIdColumn();
    await ensureMemberTypeStudioIdColumn();
    await ensureLessonPackageStudioIdColumn();
    await ensurePaymentMethodStudioIdColumn();
    await ensureEquipmentStudioIdColumn();
    await ensureExpenseStudioIdColumn();
    await ensurePaymentStudioIdColumn();
    await ensureReservationStudioIdColumn();
    await ensureAttendanceStudioIdColumn();
    await ensureMemberLessonPackageStudioIdColumn();
    await ensureManualCardUsagesTable();
    await ensureMemberMeasurementStudioIdColumn();
    await ensureMemberSoftDeleteColumns();
    await ensureAttendanceReservationColumn();
    await ensureAttendanceInstructorColumn();
    await ensureMemberMeasurementsTable();
    await ensureStudioScopedUserMemberUniqueness();
    await ensureInstructorPayoutAndSessionTypeColumns();
    await sequelize.sync();
  }

  await bootstrapLikeApp();

  const [tablesResult] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table'");
  const tableSet = new Set(tablesResult.map((row) => row.name));
  report.bootstrap.tableNames = Array.from(tableSet).sort();

  await test('required tables exist', async () => {
    const required = [
      'Studios',
      'Users',
      'StudioSubscriptionEntitlements',
      'SubscriptionPurchaseIntents',
      'apple_subscription_transactions',
      'apple_server_notification_inbox',
    ];
    for (const name of required) {
      assert.ok(tableSet.has(name), `missing table ${name}`);
    }
  });

  const studioA = await Studio.findByPk(1);
  const studioB = await Studio.create({
    name: 'Studio B',
    studioCode: 'studio-b',
    email: null,
    phone: null,
    country: 'TR',
    currency: 'TRY',
    timezone: 'Europe/Istanbul',
    subscriptionStatus: 'active',
    subscriptionPlan: 'trial',
    trialEndsAt: null,
  });

  await User.create({
    username: 'phase317-admin-a',
    password: 'x',
    role: 'admin',
    assignedSalonIds: [],
    permissions: [],
    studioId: studioA.id,
  });

  await User.create({
    username: 'phase317-admin-b',
    password: 'x',
    role: 'admin',
    assignedSalonIds: [],
    permissions: [],
    studioId: studioB.id,
  });

  const now = new Date();
  const providerSubscriptionId = 'orig-studio-a';
  const entitlement = await StudioSubscriptionEntitlement.create({
    studioId: studioA.id,
    provider: 'apple',
    plan: 'basic',
    normalizedStatus: 'expired',
    providerProductId: 'com.example.basic.sandbox',
    providerSubscriptionId,
    currentPeriodStart: subDays(now, 60),
    currentPeriodEnd: subDays(now, 30),
    trialEndsAt: null,
    autoRenewEnabled: true,
    gracePeriodEndsAt: null,
    revokedAt: null,
    refundedAt: null,
    pausedAt: null,
    lastVerifiedAt: subDays(now, 20),
    sourceLastUpdate: 'verify_endpoint',
    environment: 'sandbox',
    providerStateVersion: null,
    providerEventTime: subDays(now, 20),
  });

  await test('client module import has no side effects', async () => {
    assert.ok(appleClientModule);
    assert.strictEqual(typeof appleClientModule.getAppStoreClientConfig, 'function');
  });

  await test('client config missing keyId fails controlled', async () => {
    assert.throws(() => {
      appleClientModule.getAppStoreClientConfig({
        issuerId: 'issuer',
        bundleId: 'bundle',
        privateKey: 'key',
        environment: 'Sandbox',
      });
    }, (error) => error && error.code === 'APPLE_SERVER_API_KEY_ID_REQUIRED');
  });

  await test('client config missing issuerId fails controlled', async () => {
    assert.throws(() => {
      appleClientModule.getAppStoreClientConfig({
        keyId: 'kid',
        bundleId: 'bundle',
        privateKey: 'key',
        environment: 'Sandbox',
      });
    }, (error) => error && error.code === 'APPLE_SERVER_API_ISSUER_ID_REQUIRED');
  });

  await test('client config missing private key fails controlled', async () => {
    assert.throws(() => {
      appleClientModule.getAppStoreClientConfig({
        keyId: 'kid',
        issuerId: 'issuer',
        bundleId: 'bundle',
        environment: 'Sandbox',
      });
    }, (error) => error && error.code === 'APPLE_SERVER_API_PRIVATE_KEY_REQUIRED');
  });

  await test('client config unreadable private key path fails controlled', async () => {
    assert.throws(() => {
      appleClientModule.getAppStoreClientConfig({
        keyId: 'kid',
        issuerId: 'issuer',
        bundleId: 'bundle',
        environment: 'Sandbox',
        privateKeyPath: path.join(tmpRoot, 'missing.key'),
      });
    }, (error) => error && error.code === 'APPLE_SERVER_API_PRIVATE_KEY_READ_FAILED');
  });

  await test('client config inline key takes precedence over key path', async () => {
    const cfg = appleClientModule.getAppStoreClientConfig({
      keyId: 'kid',
      issuerId: 'issuer',
      bundleId: 'bundle',
      environment: 'Sandbox',
      privateKey: 'INLINE_KEY',
      privateKeyPath: path.join(tmpRoot, 'missing-again.key'),
    });
    assert.strictEqual(cfg.signingKey, 'INLINE_KEY');
  });

  const keyFile = path.join(tmpRoot, 'private.p8');
  fs.writeFileSync(keyFile, 'FILE_KEY', 'utf8');

  await test('client config key path selection works', async () => {
    const cfg = appleClientModule.getAppStoreClientConfig({
      keyId: 'kid',
      issuerId: 'issuer',
      bundleId: 'bundle',
      environment: 'Sandbox',
      privateKeyPath: keyFile,
    });
    assert.strictEqual(cfg.signingKey, 'FILE_KEY');
  });

  await test('client invalid environment rejected', async () => {
    assert.throws(() => {
      appleClientModule.getAppStoreClientConfig({
        keyId: 'kid',
        issuerId: 'issuer',
        bundleId: 'bundle',
        environment: 'test',
        privateKey: 'KEY',
      });
    }, (error) => error && error.code === 'APPLE_SERVER_API_ENVIRONMENT_INVALID');
  });

  await test('client constructor maps sandbox and production correctly', async () => {
    const calls = [];
    const fakeAppleLib = {
      Environment: {
        SANDBOX: 'SandboxEnum',
        PRODUCTION: 'ProductionEnum',
        LOCAL_TESTING: 'LocalTestingEnum',
        XCODE: 'XcodeEnum',
      },
      AppStoreServerAPIClient: class {
        constructor(signingKey, keyId, issuerId, bundleId, environment) {
          calls.push({ signingKey, keyId, issuerId, bundleId, environment });
        }
      },
    };

    appleClientModule.createAppleAppStoreServerApiClient({
      keyId: 'kid',
      issuerId: 'issuer',
      bundleId: 'bundle',
      environment: 'Sandbox',
      privateKey: 'KEY',
    }, { appleLib: fakeAppleLib });

    appleClientModule.createAppleAppStoreServerApiClient({
      keyId: 'kid',
      issuerId: 'issuer',
      bundleId: 'bundle',
      environment: 'Production',
      privateKey: 'KEY',
    }, { appleLib: fakeAppleLib });

    assert.strictEqual(calls[0].environment, 'SandboxEnum');
    assert.strictEqual(calls[1].environment, 'ProductionEnum');
  });

  await test('real verifier missing configuration fails controlled', async () => {
    const originalBundle = process.env.APPLE_IAP_BUNDLE_ID;
    const originalRoot = process.env.APPLE_IAP_ROOT_CA_PATHS;
    delete process.env.APPLE_IAP_BUNDLE_ID;
    delete process.env.APPLE_IAP_ROOT_CA_PATHS;

    try {
      await assert.rejects(
        verifierModule.verifyAndDecodeTransaction(makeCompactJwsToken('bad-cfg')),
        (error) => error && error.name === 'AppleVerifierConfigurationError'
      );
    } finally {
      process.env.APPLE_IAP_BUNDLE_ID = originalBundle;
      if (typeof originalRoot === 'undefined') {
        delete process.env.APPLE_IAP_ROOT_CA_PATHS;
      } else {
        process.env.APPLE_IAP_ROOT_CA_PATHS = originalRoot;
      }
    }
  });

  await test('real verifier malformed jws rejection is controlled', async () => {
    const fakeRoot = path.join(tmpRoot, 'fake-root.cer');
    fs.writeFileSync(fakeRoot, 'NOT_A_REAL_CERTIFICATE', 'utf8');
    process.env.APPLE_IAP_ROOT_CA_PATHS = fakeRoot;

    await assert.rejects(
      verifierModule.verifyAndDecodeTransaction('not-a-jws'),
      (error) => error && error.name === 'AppleVerifierError'
    );
  });

  function makeClientBundle(overrides = {}) {
    const calls = {
      statuses: [],
      history: [],
      notifications: [],
    };

    const client = {
      async getAllSubscriptionStatuses(anyTransactionId) {
        calls.statuses.push(anyTransactionId);
        if (overrides.getAllSubscriptionStatuses) {
          return overrides.getAllSubscriptionStatuses(anyTransactionId);
        }
        return { data: [] };
      },
      async getTransactionHistory(anyTransactionId, revision) {
        calls.history.push({ anyTransactionId, revision });
        if (overrides.getTransactionHistory) {
          return overrides.getTransactionHistory(anyTransactionId, revision);
        }
        return { hasMore: false, signedTransactions: [] };
      },
      async getNotificationHistory(token, request) {
        calls.notifications.push({ token, request });
        if (overrides.getNotificationHistory) {
          return overrides.getNotificationHistory(token, request);
        }
        return { hasMore: false, notificationHistory: [] };
      },
    };

    const APIError = {
      RATE_LIMIT_EXCEEDED: 4290000,
      GENERAL_INTERNAL_RETRYABLE: 5000001,
      ACCOUNT_NOT_FOUND_RETRYABLE: 4040002,
      APP_NOT_FOUND_RETRYABLE: 4040004,
      ORIGINAL_TRANSACTION_ID_NOT_FOUND_RETRYABLE: 4040006,
      ORIGINAL_TRANSACTION_ID_NOT_FOUND: 4040005,
      TRANSACTION_ID_NOT_FOUND: 4040010,
      ACCOUNT_NOT_FOUND: 4040001,
      GENERAL_BAD_REQUEST: 4000000,
    };

    class APIException extends Error {
      constructor(httpStatusCode, apiError, errorMessage) {
        super(errorMessage || 'api error');
        this.httpStatusCode = httpStatusCode;
        this.apiError = apiError;
        this.errorMessage = errorMessage || null;
      }
    }

    const appleLib = {
      APIException,
      APIError,
      ProductType: { AUTO_RENEWABLE: 'AUTO_RENEWABLE' },
      Order: { DESCENDING: 'DESCENDING' },
      GetTransactionHistoryVersion: { V2: 'v2' },
    };

    return { client, appleLib, calls };
  }

  async function resetEntitlementBaseline() {
    await StudioSubscriptionEntitlement.update({
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'com.example.basic.sandbox',
      currentPeriodStart: subDays(now, 60),
      currentPeriodEnd: subDays(now, 30),
      trialEndsAt: null,
      autoRenewEnabled: true,
      gracePeriodEndsAt: null,
      revokedAt: null,
      refundedAt: null,
      pausedAt: null,
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
      providerStateVersion: null,
      providerEventTime: subDays(now, 20),
      lastVerifiedAt: subDays(now, 20),
    }, {
      where: { id: entitlement.id },
    });

    return StudioSubscriptionEntitlement.findByPk(entitlement.id);
  }

  await test('reconcile rejects nonexistent entitlement', async () => {
    await assert.rejects(
      reconcileAppleEntitlementById({ entitlementId: 999999, dryRun: true }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_ENTITLEMENT_NOT_FOUND'
    );
  });

  await test('reconcile rejects non-apple entitlement id', async () => {
    const nonApple = await StudioSubscriptionEntitlement.create({
      studioId: studioA.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'gp.basic',
      providerSubscriptionId: 'gp-1',
      currentPeriodStart: subDays(now, 20),
      currentPeriodEnd: subDays(now, 10),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
    });

    await assert.rejects(
      reconcileAppleEntitlementById({ entitlementId: nonApple.id, dryRun: true }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_ENTITLEMENT_NOT_FOUND'
    );
  });

  await test('reconcile rejects missing providerSubscriptionId', async () => {
    const row = await StudioSubscriptionEntitlement.create({
      studioId: studioA.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'com.example.basic.sandbox',
      providerSubscriptionId: null,
      currentPeriodEnd: subDays(now, 2),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
    });

    await assert.rejects(
      reconcileAppleEntitlementById({ entitlementId: row.id, dryRun: true }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_BINDING_INVALID'
    );
  });

  await test('reconcile uses stored providerSubscriptionId for API identity', async () => {
    await resetEntitlementBaseline();
    const signedTx = makeCompactJwsToken('api-identity');
    const verifiers = buildStubVerifiers({
      transactions: {
        [signedTx]: {
          environment: 'Sandbox',
          transactionId: 'tx-api-identity',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: subDays(now, 2).getTime(),
          expiresDate: addDays(now, 10).getTime(),
          signedDate: addDays(now, 1).getTime(),
        },
      },
      renewals: {},
    });

    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{
          subscriptionGroupIdentifier: 'group-1',
          lastTransactions: [{ status: 1, signedTransactionInfo: signedTx }],
        }],
      }),
    });

    await reconcileAppleEntitlementById({
      entitlementId: entitlement.id,
      dryRun: false,
      repairLedger: false,
      dependencies: {
        clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
        verifyTransactionFn: verifiers.verifyTransactionFn,
      },
    });

    assert.deepStrictEqual(bundle.calls.statuses, [providerSubscriptionId]);
  });

  async function runStatusScenario({
    name,
    apiStatus,
    txPayload,
    renewalPayload,
    expect,
  }) {
    await test(name, async () => {
      await resetEntitlementBaseline();
      const signedTx = makeCompactJwsToken(`${name}-tx`);
      const signedRenewal = renewalPayload ? makeCompactJwsToken(`${name}-renew`) : null;

      const txMap = { [signedTx]: txPayload };
      const renewalMap = signedRenewal ? { [signedRenewal]: renewalPayload } : {};
      const verifiers = buildStubVerifiers({ transactions: txMap, renewals: renewalMap });

      const bundle = makeClientBundle({
        getAllSubscriptionStatuses: async () => ({
          data: [{
            subscriptionGroupIdentifier: 'group-1',
            lastTransactions: [{
              status: apiStatus,
              signedTransactionInfo: signedTx,
              signedRenewalInfo: signedRenewal,
            }],
          }],
        }),
      });

      const beforeStudio = await Studio.findByPk(studioA.id);
      const beforeMirror = {
        subscriptionStatus: beforeStudio.subscriptionStatus,
        subscriptionPlan: beforeStudio.subscriptionPlan,
        trialEndsAt: beforeStudio.trialEndsAt ? beforeStudio.trialEndsAt.toISOString() : null,
      };

      await reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        dryRun: false,
        repairLedger: false,
        dependencies: {
          clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
          verifyTransactionFn: verifiers.verifyTransactionFn,
          verifyRenewalFn: verifiers.verifyRenewalFn,
        },
      });

      const updated = await StudioSubscriptionEntitlement.findByPk(entitlement.id);
      assert.strictEqual(updated.normalizedStatus, expect.normalizedStatus);
      if (Object.prototype.hasOwnProperty.call(expect, 'plan')) {
        assert.strictEqual(updated.plan, expect.plan);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'autoRenewEnabled')) {
        assert.strictEqual(updated.autoRenewEnabled, expect.autoRenewEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'trialEndsAtNull') && expect.trialEndsAtNull) {
        assert.strictEqual(updated.trialEndsAt, null);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'trialEndsAtEqualsExpires') && expect.trialEndsAtEqualsExpires) {
        assert.ok(updated.trialEndsAt instanceof Date);
        assert.strictEqual(updated.trialEndsAt.getTime(), new Date(txPayload.expiresDate).getTime());
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'graceSet') && expect.graceSet) {
        assert.ok(updated.gracePeriodEndsAt instanceof Date);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'revokedAtSet') && expect.revokedAtSet) {
        assert.ok(updated.revokedAt instanceof Date);
      }

      assert.strictEqual(updated.sourceLastUpdate, 'reconciliation');
      assert.ok(updated.lastVerifiedAt instanceof Date);

      const afterStudio = await Studio.findByPk(studioA.id);
      const afterMirror = {
        subscriptionStatus: afterStudio.subscriptionStatus,
        subscriptionPlan: afterStudio.subscriptionPlan,
        trialEndsAt: afterStudio.trialEndsAt ? afterStudio.trialEndsAt.toISOString() : null,
      };
      assert.deepStrictEqual(afterMirror, beforeMirror);
    });
  }

  await runStatusScenario({
    name: 'status mapping active trial',
    apiStatus: 1,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-trial',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      offerDiscountType: 'FREE_TRIAL',
      purchaseDate: now.getTime(),
      expiresDate: addDays(now, 7).getTime(),
      signedDate: now.getTime(),
    },
    renewalPayload: {
      environment: 'Sandbox',
      originalTransactionId: providerSubscriptionId,
      autoRenewStatus: 1,
      signedDate: now.getTime(),
    },
    expect: {
      normalizedStatus: 'trialing',
      plan: 'basic',
      trialEndsAtEqualsExpires: true,
      autoRenewEnabled: true,
    },
  });

  await runStatusScenario({
    name: 'status mapping active paid',
    apiStatus: 1,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-active',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.pro.sandbox',
      purchaseDate: now.getTime(),
      expiresDate: addDays(now, 10).getTime(),
      signedDate: addDays(now, 1).getTime(),
    },
    renewalPayload: null,
    expect: {
      normalizedStatus: 'active',
      plan: 'pro',
      trialEndsAtNull: true,
    },
  });

  await runStatusScenario({
    name: 'status mapping expired',
    apiStatus: 2,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-expired',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: subDays(now, 10).getTime(),
      expiresDate: subDays(now, 1).getTime(),
      signedDate: subDays(now, 1).getTime(),
    },
    renewalPayload: null,
    expect: {
      normalizedStatus: 'expired',
      plan: 'basic',
    },
  });

  await runStatusScenario({
    name: 'status mapping billing retry',
    apiStatus: 3,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-retry',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: subDays(now, 3).getTime(),
      expiresDate: subDays(now, 1).getTime(),
      signedDate: now.getTime(),
    },
    renewalPayload: {
      environment: 'Sandbox',
      originalTransactionId: providerSubscriptionId,
      isInBillingRetryPeriod: true,
      signedDate: now.getTime(),
    },
    expect: {
      normalizedStatus: 'expired',
      plan: 'basic',
    },
  });

  await runStatusScenario({
    name: 'status mapping grace period',
    apiStatus: 4,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-grace',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: subDays(now, 3).getTime(),
      expiresDate: subDays(now, 1).getTime(),
      signedDate: now.getTime(),
    },
    renewalPayload: {
      environment: 'Sandbox',
      originalTransactionId: providerSubscriptionId,
      gracePeriodExpiresDate: addDays(now, 3).getTime(),
      signedDate: now.getTime(),
    },
    expect: {
      normalizedStatus: 'expired',
      graceSet: true,
    },
  });

  await runStatusScenario({
    name: 'status mapping revoked',
    apiStatus: 5,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-revoked',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: subDays(now, 5).getTime(),
      expiresDate: addDays(now, 20).getTime(),
      revocationDate: now.getTime(),
      signedDate: now.getTime(),
    },
    renewalPayload: null,
    expect: {
      normalizedStatus: 'revoked',
      revokedAtSet: true,
    },
  });

  await runStatusScenario({
    name: 'status mapping auto renew off remains active',
    apiStatus: 1,
    txPayload: {
      environment: 'Sandbox',
      transactionId: 'tx-autorenew-off',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: subDays(now, 1).getTime(),
      expiresDate: addDays(now, 8).getTime(),
      signedDate: now.getTime(),
    },
    renewalPayload: {
      environment: 'Sandbox',
      originalTransactionId: providerSubscriptionId,
      autoRenewStatus: 0,
      signedDate: now.getTime(),
    },
    expect: {
      normalizedStatus: 'active',
      autoRenewEnabled: false,
    },
  });

  await test('multiple status items choose newer matching lineage not array order', async () => {
    await resetEntitlementBaseline();
    const signedOld = makeCompactJwsToken('old-expired');
    const signedNew = makeCompactJwsToken('new-active');
    const signedOther = makeCompactJwsToken('other-lineage');

    const verifiers = buildStubVerifiers({
      transactions: {
        [signedOld]: {
          environment: 'Sandbox',
          transactionId: 'tx-old-expired',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: subDays(now, 30).getTime(),
          expiresDate: subDays(now, 20).getTime(),
          signedDate: subDays(now, 20).getTime(),
        },
        [signedNew]: {
          environment: 'Sandbox',
          transactionId: 'tx-new-active',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: subDays(now, 1).getTime(),
          expiresDate: addDays(now, 10).getTime(),
          signedDate: addDays(now, 1).getTime(),
        },
        [signedOther]: {
          environment: 'Sandbox',
          transactionId: 'tx-other',
          originalTransactionId: 'other-lineage',
          productId: 'com.example.basic.sandbox',
          purchaseDate: subDays(now, 1).getTime(),
          expiresDate: addDays(now, 10).getTime(),
          signedDate: addDays(now, 2).getTime(),
        },
      },
      renewals: {},
    });

    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{
          subscriptionGroupIdentifier: 'g1',
          lastTransactions: [
            { status: 2, signedTransactionInfo: signedOld },
            { status: 1, signedTransactionInfo: signedOther },
            { status: 1, signedTransactionInfo: signedNew },
          ],
        }],
      }),
    });

    await reconcileAppleEntitlementById({
      entitlementId: entitlement.id,
      dryRun: false,
      repairLedger: false,
      dependencies: {
        clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
        verifyTransactionFn: verifiers.verifyTransactionFn,
      },
    });

    const updated = await StudioSubscriptionEntitlement.findByPk(entitlement.id);
    assert.strictEqual(updated.normalizedStatus, 'active');
    assert.strictEqual(updated.providerSubscriptionId, providerSubscriptionId);
  });

  await test('history pagination progression, dedupe, and lineage filtering', async () => {
    await AppleSubscriptionTransaction.destroy({ where: {} });
    await resetEntitlementBaseline();

    const signedH1 = makeCompactJwsToken('h1');
    const signedH2 = makeCompactJwsToken('h2');
    const signedDup = makeCompactJwsToken('hdup');
    const signedOther = makeCompactJwsToken('hother');

    const verifiers = buildStubVerifiers({
      transactions: {
        [signedH1]: {
          environment: 'Sandbox',
          transactionId: 'tx-h1',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 5).getTime(),
          signedDate: now.getTime(),
        },
        [signedH2]: {
          environment: 'Sandbox',
          transactionId: 'tx-h2',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.pro.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 9).getTime(),
          signedDate: addDays(now, 1).getTime(),
        },
        [signedDup]: {
          environment: 'Sandbox',
          transactionId: 'tx-h1',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 5).getTime(),
          signedDate: now.getTime(),
        },
        [signedOther]: {
          environment: 'Sandbox',
          transactionId: 'tx-h-other',
          originalTransactionId: 'other-lineage',
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 5).getTime(),
          signedDate: now.getTime(),
        },
      },
      renewals: {},
    });

    const statusSigned = makeCompactJwsToken('status-hist');

    const historyByRevision = {
      null: { hasMore: true, revision: 'r1', signedTransactions: [signedH1, signedOther] },
      r1: { hasMore: true, revision: 'r2', signedTransactions: [signedDup] },
      r2: { hasMore: false, revision: 'r3', signedTransactions: [signedH2] },
    };

    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{
          subscriptionGroupIdentifier: 'g1',
          lastTransactions: [{
            status: 1,
            signedTransactionInfo: statusSigned,
          }],
        }],
      }),
      getTransactionHistory: async (_id, revision) => {
        const key = revision === null ? 'null' : revision;
        return clone(historyByRevision[key]);
      },
    });

    const statusTxPayload = {
      environment: 'Sandbox',
      transactionId: 'tx-status-history',
      originalTransactionId: providerSubscriptionId,
      productId: 'com.example.basic.sandbox',
      purchaseDate: now.getTime(),
      expiresDate: addDays(now, 10).getTime(),
      signedDate: addDays(now, 2).getTime(),
    };

    const wrappedVerifier = async (signed) => {
      if (signed === statusSigned) return clone(statusTxPayload);
      return verifiers.verifyTransactionFn(signed);
    };

    await reconcileAppleEntitlementById({
      entitlementId: entitlement.id,
      dryRun: false,
      repairLedger: true,
      historyMaxPages: 5,
      historyMaxTransactions: 10,
      dependencies: {
        clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
        verifyTransactionFn: wrappedVerifier,
      },
    });

    assert.deepStrictEqual(bundle.calls.history.map((item) => item.revision), [null, 'r1', 'r2']);
    const rows = await AppleSubscriptionTransaction.findAll({ where: { studioId: studioA.id } });
    const txIds = rows.map((row) => row.transactionId);
    assert.ok(txIds.includes('tx-h1'));
    assert.ok(txIds.includes('tx-h2'));
    assert.ok(!txIds.includes('tx-h-other'));
    assert.strictEqual(txIds.filter((id) => id === 'tx-h1').length, 1);
  });

  await test('history pagination missing revision fails controllably', async () => {
    await resetEntitlementBaseline();
    const signedStatus = makeCompactJwsToken('status-missing-revision');

    const verifiers = buildStubVerifiers({
      transactions: {
        [signedStatus]: {
          environment: 'Sandbox',
          transactionId: 'tx-status-miss',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 2).getTime(),
          signedDate: now.getTime(),
        },
      },
      renewals: {},
    });

    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signedStatus }] }],
      }),
      getTransactionHistory: async () => ({ hasMore: true, revision: null, signedTransactions: [] }),
    });

    await assert.rejects(
      reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        dryRun: false,
        repairLedger: true,
        dependencies: {
          clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
          verifyTransactionFn: verifiers.verifyTransactionFn,
        },
      }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_HISTORY_PAGINATION_INVALID'
    );
  });

  await test('history pagination stalled revision fails controllably', async () => {
    await resetEntitlementBaseline();
    const signedStatus = makeCompactJwsToken('status-stalled');

    const verifiers = buildStubVerifiers({
      transactions: {
        [signedStatus]: {
          environment: 'Sandbox',
          transactionId: 'tx-status-stalled',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 2).getTime(),
          signedDate: now.getTime(),
        },
      },
      renewals: {},
    });

    let callCount = 0;
    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signedStatus }] }],
      }),
      getTransactionHistory: async () => {
        callCount += 1;
        if (callCount === 1) return { hasMore: true, revision: 'same', signedTransactions: [] };
        return { hasMore: true, revision: 'same', signedTransactions: [] };
      },
    });

    await assert.rejects(
      reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        dryRun: false,
        repairLedger: true,
        historyMaxPages: 3,
        dependencies: {
          clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
          verifyTransactionFn: verifiers.verifyTransactionFn,
        },
      }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_HISTORY_PAGINATION_STALLED'
    );
  });

  await test('notification history recovery pagination and count limit', async () => {
    const ingested = [];
    const bundle = makeClientBundle({
      getNotificationHistory: async (token) => {
        if (token === null) {
          return {
            hasMore: true,
            paginationToken: 'n1',
            notificationHistory: [
              { signedPayload: makeCompactJwsToken('notif-1') },
              { signedPayload: makeCompactJwsToken('notif-2') },
            ],
          };
        }
        return {
          hasMore: false,
          paginationToken: 'n2',
          notificationHistory: [
            { signedPayload: makeCompactJwsToken('notif-3') },
          ],
        };
      },
    });

    const result = await recoverAppleNotificationHistoryForEntitlement({
      entitlementId: entitlement.id,
      maxPages: 5,
      maxNotifications: 2,
      dependencies: {
        clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
        ingestSignedPayloadFn: async ({ signedPayload }) => {
          ingested.push(signedPayload);
        },
      },
    });

    assert.strictEqual(result.ingestedCount, 2);
    assert.strictEqual(ingested.length, 2);
  });

  await test('sandbox notification lookback cap enforced', async () => {
    const bundle = makeClientBundle({});
    await assert.rejects(
      recoverAppleNotificationHistoryForEntitlement({
        entitlementId: entitlement.id,
        startDate: subDays(now, 31),
        endDate: now,
        dependencies: {
          clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
          ingestSignedPayloadFn: async () => {},
        },
      }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_NOTIFICATION_LOOKBACK_TOO_OLD'
    );
  });

  await test('retry due failed inbox selection and batching', async () => {
    await AppleServerNotificationInbox.destroy({ where: {} });

    const dueOld = await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-old',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('due-old'),
      processingState: 'failed',
      attemptCount: 1,
      nextAttemptAt: subDays(now, 1),
    });

    await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-new',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('due-new'),
      processingState: 'failed',
      attemptCount: 1,
      nextAttemptAt: subDays(now, 0.5),
    });

    await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-future',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('future'),
      processingState: 'failed',
      attemptCount: 1,
      nextAttemptAt: addDays(now, 1),
    });

    await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-max',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('max-attempt'),
      processingState: 'failed',
      attemptCount: 3,
      nextAttemptAt: subDays(now, 1),
    });

    await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-null-next',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('null-next'),
      processingState: 'failed',
      attemptCount: 1,
      nextAttemptAt: null,
    });

    await AppleServerNotificationInbox.create({
      environment: 'Sandbox',
      notificationUUID: 'n-processed',
      notificationType: 'SUBSCRIBED',
      signedPayload: makeCompactJwsToken('processed'),
      processingState: 'processed',
      attemptCount: 0,
      nextAttemptAt: subDays(now, 1),
    });

    const callOrder = [];
    const result = await retryDueFailedAppleNotificationInbox({
      limit: 1,
      now,
      dependencies: {
        ingestSignedPayloadFn: async ({ signedPayload }) => {
          callOrder.push(signedPayload);
        },
      },
    });

    assert.strictEqual(result.attempted, 1);
    assert.strictEqual(callOrder.length, 1);
    assert.strictEqual(callOrder[0], dueOld.signedPayload);
  });

  await test('api error classification retryable and non-retryable', async () => {
    await resetEntitlementBaseline();
    const signedStatus = makeCompactJwsToken('status-errors');

    const verifiers = buildStubVerifiers({
      transactions: {
        [signedStatus]: {
          environment: 'Sandbox',
          transactionId: 'tx-status-errors',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 3).getTime(),
          signedDate: now.getTime(),
        },
      },
      renewals: {},
    });

    const base = makeClientBundle({
      getAllSubscriptionStatuses: async () => ({
        data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signedStatus }] }],
      }),
    });

    const rateLimitedBundle = {
      client: {
        ...base.client,
        async getTransactionHistory() {
          throw new base.appleLib.APIException(429, base.appleLib.APIError.RATE_LIMIT_EXCEEDED, 'rate limited');
        },
      },
      appleLib: base.appleLib,
    };

    await assert.rejects(
      reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        repairLedger: true,
        dependencies: {
          clientBundle: rateLimitedBundle,
          verifyTransactionFn: verifiers.verifyTransactionFn,
        },
      }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_API_RETRYABLE' && error.retryable === true
    );

    const notFoundBundle = {
      client: {
        ...base.client,
        async getAllSubscriptionStatuses() {
          throw new base.appleLib.APIException(404, base.appleLib.APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND, 'not found');
        },
      },
      appleLib: base.appleLib,
    };

    await assert.rejects(
      reconcileAppleEntitlementById({
        entitlementId: entitlement.id,
        repairLedger: false,
        dependencies: {
          clientBundle: notFoundBundle,
          verifyTransactionFn: verifiers.verifyTransactionFn,
        },
      }),
      (error) => error instanceof AppleReconciliationError && error.code === 'APPLE_RECONCILIATION_SUBSCRIPTION_NOT_FOUND' && error.retryable === false
    );
  });

  await test('batch reconciliation limit and apple-only filtering', async () => {
    await StudioSubscriptionEntitlement.create({
      studioId: studioA.id,
      provider: 'google_play',
      plan: 'basic',
      normalizedStatus: 'expired',
      providerProductId: 'gp-basic',
      providerSubscriptionId: 'gp-sub',
      currentPeriodEnd: subDays(now, 40),
      sourceLastUpdate: 'verify_endpoint',
      environment: 'production',
      lastVerifiedAt: subDays(now, 3),
    });

    const e2 = await StudioSubscriptionEntitlement.create({
      studioId: studioA.id,
      provider: 'apple',
      plan: 'basic',
      normalizedStatus: 'active',
      providerProductId: 'com.example.basic.sandbox',
      providerSubscriptionId: 'orig-studio-a-2',
      sourceLastUpdate: 'verify_endpoint',
      environment: 'sandbox',
      lastVerifiedAt: null,
    });

    const signedStatusA = makeCompactJwsToken('batch-a');
    const signedStatusB = makeCompactJwsToken('batch-b');
    const verifiers = buildStubVerifiers({
      transactions: {
        [signedStatusA]: {
          environment: 'Sandbox',
          transactionId: 'tx-batch-a',
          originalTransactionId: providerSubscriptionId,
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 2).getTime(),
          signedDate: now.getTime(),
        },
        [signedStatusB]: {
          environment: 'Sandbox',
          transactionId: 'tx-batch-b',
          originalTransactionId: 'orig-studio-a-2',
          productId: 'com.example.basic.sandbox',
          purchaseDate: now.getTime(),
          expiresDate: addDays(now, 2).getTime(),
          signedDate: now.getTime(),
        },
      },
      renewals: {},
    });

    const bundle = makeClientBundle({
      getAllSubscriptionStatuses: async (id) => {
        const signed = id === providerSubscriptionId ? signedStatusA : signedStatusB;
        return { data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signed }] }] };
      },
    });

    const result = await reconcileAppleEntitlementsBatch({
      limit: 1,
      dryRun: true,
      repairLedger: false,
      dependencies: {
        clientBundle: { client: bundle.client, appleLib: bundle.appleLib },
        verifyTransactionFn: verifiers.verifyTransactionFn,
      },
    });

    assert.strictEqual(result.attempted, 1);
    assert.strictEqual(result.succeeded, 1);
    assert.ok(result.results.length <= 1);

    await e2.destroy();
  });

  await test('CLI help and safe mode validation on disposable DB', async () => {
    const harnessModulePath = path.join(tmpRoot, 'cliHarnessDeps.js');
    fs.writeFileSync(
      harnessModulePath,
      [
        'module.exports = {',
        '  verifyTransactionFn: async (signed) => ({',
        "    environment: 'Sandbox',",
        "    transactionId: signed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'txcli',",
        "    originalTransactionId: 'orig-studio-a',",
        "    productId: 'com.example.basic.sandbox',",
        '    purchaseDate: Date.now(),',
        '    expiresDate: Date.now() + 3600000,',
        '    signedDate: Date.now(),',
        '  }),',
        '  verifyRenewalFn: async () => ({',
        "    environment: 'Sandbox',",
        "    originalTransactionId: 'orig-studio-a',",
        '    autoRenewStatus: 1,',
        '    signedDate: Date.now(),',
        '  }),',
        '  clientBundle: {',
        '    client: {',
        "      getAllSubscriptionStatuses: async () => ({ data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: 'cli.payload.signature' }] }] }),",
        "      getTransactionHistory: async () => ({ hasMore: false, revision: 'done', signedTransactions: [] }),",
        "      getNotificationHistory: async () => ({ hasMore: false, notificationHistory: [] }),",
        '    },',
        '    appleLib: {',
        '      ProductType: { AUTO_RENEWABLE: "AUTO_RENEWABLE" },',
        '      Order: { DESCENDING: "DESCENDING" },',
        '      GetTransactionHistoryVersion: { V2: "v2" },',
        '    },',
        '  },',
        '};',
      ].join('\n'),
      'utf8'
    );

    const env = {
      ...process.env,
      DB_PATH: dbPath,
      APPLE_RECONCILIATION_HARNESS_MODULE: harnessModulePath,
    };

    const helpRun = spawnSync('node', ['scripts/reconcileAppleSubscriptions.js', '--help'], { env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.strictEqual(helpRun.status, 0);

    const noModeRun = spawnSync('node', ['scripts/reconcileAppleSubscriptions.js'], { env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.notStrictEqual(noModeRun.status, 0);

    const dryRun = spawnSync('node', ['scripts/reconcileAppleSubscriptions.js', '--entitlement-id', String(entitlement.id), '--dry-run'], { env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.strictEqual(dryRun.status, 0);

    const text = String(dryRun.stdout || '');
    assert.ok(!text.includes('transactionId'));
    assert.ok(!text.includes('originalTransactionId'));
    assert.ok(!text.includes('signedPayload'));
    assert.ok(!text.includes('appAccountToken'));
    assert.ok(!text.includes('com.example'));
  });

  report.summary = {
    passed: report.testsPassed.length,
    failed: report.testsFailed.length,
  };

  console.log(JSON.stringify(report, null, 2));

  await sequelize.close();

  try {
    fs.unlinkSync(dbPath);
  } catch (error) {
    // ignore
  }
}

run()
  .catch(async (error) => {
    const output = {
      error: {
        code: error && error.code ? String(error.code) : 'VALIDATION_FAILED',
        message: error && error.message ? String(error.message) : 'Validation failed',
      },
    };
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  })
  .finally(() => {
    for (const targetPath of createdTempPaths) {
      try {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } catch (error) {
        // ignore cleanup failures
      }
    }
  });
