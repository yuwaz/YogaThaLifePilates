const {
  sequelize,
} = require('../models');
const {
  reconcileAppleEntitlementById,
  reconcileAppleEntitlementsBatch,
  recoverAppleNotificationHistoryForEntitlement,
  retryDueFailedAppleNotificationInbox,
  AppleReconciliationError,
} = require('../services/appleReconciliationService');

function parseArgs(argv) {
  const args = {
    entitlementId: null,
    batch: false,
    limit: 10,
    dryRun: false,
    noLedgerRepair: false,
    historyMaxPages: 10,
    retryFailedInbox: false,
    retryLimit: 25,
    recoverNotifications: false,
    recoverDays: 1,
    notificationMaxPages: 10,
    onlyFailures: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--entitlement-id') {
      const next = argv[index + 1];
      args.entitlementId = Number(next);
      index += 1;
      continue;
    }

    if (token === '--batch') {
      args.batch = true;
      continue;
    }

    if (token === '--limit') {
      args.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--batch-size') {
      args.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token === '--no-ledger-repair') {
      args.noLedgerRepair = true;
      continue;
    }

    if (token === '--history-max-pages') {
      args.historyMaxPages = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--retry-failed-inbox') {
      args.retryFailedInbox = true;
      continue;
    }

    if (token === '--retry-limit') {
      args.retryLimit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--recover-notifications') {
      args.recoverNotifications = true;
      continue;
    }

    if (token === '--recover-days') {
      args.recoverDays = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--notification-max-pages') {
      args.notificationMaxPages = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--only-failures') {
      args.onlyFailures = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/reconcileAppleSubscriptions.js --entitlement-id <id> [options]');
  console.log('  node scripts/reconcileAppleSubscriptions.js --batch [--limit <n>] [options]');
  console.log('Options:');
  console.log('  --dry-run');
  console.log('  --batch-size <n> (alias of --limit)');
  console.log('  --no-ledger-repair');
  console.log('  --history-max-pages <n>');
  console.log('  --retry-failed-inbox [--retry-limit <n>]');
  console.log('  --recover-notifications --recover-days <n> [--notification-max-pages <n>] [--only-failures]');
}

function loadHarnessDependencies() {
  const modulePath = process.env.APPLE_RECONCILIATION_HARNESS_MODULE;
  if (typeof modulePath !== 'string' || modulePath.trim() === '') {
    return {};
  }

  const loaded = require(modulePath.trim());
  if (!loaded || typeof loaded !== 'object') {
    return {};
  }

  return loaded;
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const out = {};
  if (Object.prototype.hasOwnProperty.call(result, 'attempted')) out.attempted = result.attempted;
  if (Object.prototype.hasOwnProperty.call(result, 'succeeded')) out.succeeded = result.succeeded;
  if (Object.prototype.hasOwnProperty.call(result, 'failed')) out.failed = result.failed;
  if (Object.prototype.hasOwnProperty.call(result, 'skipped')) out.skipped = result.skipped;
  if (Object.prototype.hasOwnProperty.call(result, 'pages')) out.pages = result.pages;
  if (Object.prototype.hasOwnProperty.call(result, 'upsertedCount')) out.upsertedCount = result.upsertedCount;
  if (Object.prototype.hasOwnProperty.call(result, 'decodedStatusRows')) out.decodedStatusRows = result.decodedStatusRows;
  if (Object.prototype.hasOwnProperty.call(result, 'applied')) out.applied = result.applied;
  if (Object.prototype.hasOwnProperty.call(result, 'dryRun')) out.dryRun = result.dryRun;
  if (Object.prototype.hasOwnProperty.call(result, 'wouldApply')) out.wouldApply = result.wouldApply;
  if (Object.prototype.hasOwnProperty.call(result, 'truncated')) out.truncated = result.truncated;
  if (result.ledgerRepair && typeof result.ledgerRepair === 'object') {
    out.ledgerRepair = {
      attempted: Boolean(result.ledgerRepair.attempted),
      pages: Number(result.ledgerRepair.pages || 0),
      upsertedCount: Number(result.ledgerRepair.upsertedCount || 0),
      truncated: Boolean(result.ledgerRepair.truncated),
      skippedByDryRun: Boolean(result.ledgerRepair.skippedByDryRun),
    };
  }
  if (Array.isArray(result.results)) {
    out.results = result.results.map((item) => {
      if (!item || typeof item !== 'object') {
        return { status: 'unknown' };
      }
      if (item.errorCode) {
        return {
          errorCode: item.errorCode,
          retryable: Boolean(item.retryable),
        };
      }

      const entry = {};
      if (Object.prototype.hasOwnProperty.call(item, 'applied')) entry.applied = item.applied;
      if (Object.prototype.hasOwnProperty.call(item, 'dryRun')) entry.dryRun = item.dryRun;
      if (Object.prototype.hasOwnProperty.call(item, 'wouldApply')) entry.wouldApply = item.wouldApply;
      if (Object.prototype.hasOwnProperty.call(item, 'decodedStatusRows')) entry.decodedStatusRows = item.decodedStatusRows;
      return entry;
    });
  }

  return out;
}

function validateArgs(args) {
  const hasEntitlementId = Number.isInteger(args.entitlementId) && args.entitlementId > 0;
  const hasBatch = Boolean(args.batch);

  if (hasEntitlementId === hasBatch) {
    throw new Error('Specify exactly one mode: --entitlement-id <id> or --batch');
  }

  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    throw new Error('--limit must be a positive integer');
  }

  if (!Number.isInteger(args.retryLimit) || args.retryLimit <= 0) {
    throw new Error('--retry-limit must be a positive integer');
  }

  if (!Number.isInteger(args.historyMaxPages) || args.historyMaxPages <= 0) {
    throw new Error('--history-max-pages must be a positive integer');
  }

  if (!Number.isInteger(args.notificationMaxPages) || args.notificationMaxPages <= 0) {
    throw new Error('--notification-max-pages must be a positive integer');
  }

  if (!Number.isInteger(args.recoverDays) || args.recoverDays <= 0 || args.recoverDays > 180) {
    throw new Error('--recover-days must be a positive integer up to 180');
  }

  if (args.recoverNotifications && !hasEntitlementId) {
    throw new Error('--recover-notifications requires --entitlement-id mode');
  }
}

function toSafeError(error) {
  if (!error || typeof error !== 'object') {
    return {
      code: 'APPLE_RECONCILIATION_FAILED',
      message: 'Apple reconciliation failed',
      retryable: false,
    };
  }

  return {
    code: typeof error.code === 'string' ? error.code : 'APPLE_RECONCILIATION_FAILED',
    message: typeof error.message === 'string' && error.message.trim() !== ''
      ? error.message
      : 'Apple reconciliation failed',
    retryable: Boolean(error.retryable),
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  validateArgs(args);
  const harnessDependencies = loadHarnessDependencies();

  const now = new Date();
  const output = {
    mode: args.batch ? 'batch' : 'entitlement',
    dryRun: args.dryRun,
    startedAt: now.toISOString(),
  };

  if (args.batch) {
    output.reconcile = await reconcileAppleEntitlementsBatch({
      limit: args.limit,
      dryRun: args.dryRun,
      repairLedger: !args.noLedgerRepair,
      historyMaxPages: args.historyMaxPages,
      now,
      dependencies: harnessDependencies,
    });
  } else {
    output.reconcile = await reconcileAppleEntitlementById({
      entitlementId: args.entitlementId,
      dryRun: args.dryRun,
      repairLedger: !args.noLedgerRepair,
      historyMaxPages: args.historyMaxPages,
      now,
      dependencies: harnessDependencies,
    });

    if (args.recoverNotifications) {
      const endDate = now;
      const startDate = new Date(now.getTime() - args.recoverDays * 24 * 60 * 60 * 1000);

      output.notificationRecovery = await recoverAppleNotificationHistoryForEntitlement({
        entitlementId: args.entitlementId,
        startDate,
        endDate,
        maxPages: args.notificationMaxPages,
        onlyFailures: args.onlyFailures,
        now,
        dependencies: harnessDependencies,
      });
    }
  }

  if (args.retryFailedInbox) {
    output.retryFailedInbox = await retryDueFailedAppleNotificationInbox({
      limit: args.retryLimit,
      now,
      dependencies: harnessDependencies,
    });
  }

  output.completedAt = new Date().toISOString();
  const safeOutput = {
    mode: output.mode,
    dryRun: output.dryRun,
    startedAt: output.startedAt,
    completedAt: output.completedAt,
    reconcile: sanitizeResult(output.reconcile),
    notificationRecovery: sanitizeResult(output.notificationRecovery),
    retryFailedInbox: sanitizeResult(output.retryFailedInbox),
  };
  console.log(JSON.stringify(safeOutput, null, 2));
}

run()
  .catch((error) => {
    const safe = toSafeError(error);
    const statusCode = error instanceof AppleReconciliationError ? 2 : 1;
    console.error(JSON.stringify({ error: safe }, null, 2));
    process.exit(statusCode);
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (closeError) {
      // ignore close failures
    }
  });
