const {
  reconcileGooglePlayEntitlement,
  reconcileGooglePlayEntitlementBatch,
  retryDueGoogleRtdnInbox,
  GooglePlayReconciliationError,
} = require('../services/googlePlayReconciliationService');

function parseArgs(argv) {
  const args = {
    entitlementId: null,
    batch: false,
    retryNotifications: false,
    dryRun: false,
    batchSize: undefined,
    lookbackDays: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--batch') {
      args.batch = true;
      continue;
    }

    if (token === '--retry-notifications') {
      args.retryNotifications = true;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token.startsWith('--entitlement-id=')) {
      args.entitlementId = Number(token.split('=')[1]);
      continue;
    }

    if (token === '--entitlement-id') {
      args.entitlementId = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token.startsWith('--batch-size=')) {
      args.batchSize = Number(token.split('=')[1]);
      continue;
    }

    if (token === '--batch-size') {
      args.batchSize = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token.startsWith('--lookback-days=')) {
      args.lookbackDays = Number(token.split('=')[1]);
      continue;
    }

    if (token === '--lookback-days') {
      args.lookbackDays = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/reconcileGooglePlaySubscriptions.js --entitlement-id=<id> [--dry-run]');
  console.log('  node scripts/reconcileGooglePlaySubscriptions.js --batch [--batch-size=<n>] [--lookback-days=<n>] [--dry-run]');
  console.log('  node scripts/reconcileGooglePlaySubscriptions.js --retry-notifications [--batch-size=<n>]');
  console.log('  node scripts/reconcileGooglePlaySubscriptions.js --batch --retry-notifications [--batch-size=<n>] [--lookback-days=<n>]');
}

function loadHarnessDependencies() {
  const modulePath = process.env.GOOGLE_PLAY_RECONCILIATION_HARNESS_MODULE;
  if (typeof modulePath !== 'string' || modulePath.trim() === '') {
    return {};
  }

  const loaded = require(modulePath.trim());
  if (!loaded || typeof loaded !== 'object') {
    return {};
  }

  return loaded;
}

function validateArgs(args) {
  const hasSingle = Number.isInteger(args.entitlementId) && args.entitlementId > 0;
  const hasBatch = Boolean(args.batch);
  const hasRetry = Boolean(args.retryNotifications);

  if (!hasSingle && !hasBatch && !hasRetry) {
    throw new Error('No mode selected. Use --entitlement-id, --batch, and/or --retry-notifications.');
  }

  if (hasSingle && hasBatch) {
    throw new Error('Use either --entitlement-id or --batch, not both.');
  }

  if (args.dryRun && hasRetry) {
    throw new Error('--dry-run cannot be used with --retry-notifications.');
  }

  if (typeof args.batchSize !== 'undefined' && !Number.isInteger(args.batchSize)) {
    throw new Error('--batch-size must be an integer.');
  }

  if (typeof args.lookbackDays !== 'undefined' && !Number.isInteger(args.lookbackDays)) {
    throw new Error('--lookback-days must be an integer.');
  }
}

function toSafeError(error) {
  if (!error || typeof error !== 'object') {
    return {
      code: 'GOOGLE_PLAY_RECONCILIATION_FAILED',
      message: 'Google Play reconciliation failed',
      retryable: false,
    };
  }

  return {
    code: typeof error.code === 'string' ? error.code : 'GOOGLE_PLAY_RECONCILIATION_FAILED',
    message: typeof error.message === 'string' && error.message.trim() !== ''
      ? error.message
      : 'Google Play reconciliation failed',
    retryable: Boolean(error.retryable),
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return {
      mode: 'help',
    };
  }

  validateArgs(args);

  const dependencies = loadHarnessDependencies();
  const now = new Date();
  const output = {
    startedAt: now.toISOString(),
    dryRun: Boolean(args.dryRun),
  };

  if (Number.isInteger(args.entitlementId) && args.entitlementId > 0) {
    output.mode = 'entitlement';
    output.reconcile = await reconcileGooglePlayEntitlement({
      entitlementId: args.entitlementId,
      now,
      options: { dryRun: Boolean(args.dryRun) },
      dependencies,
    });
  }

  if (args.batch) {
    output.mode = output.mode ? `${output.mode}+batch` : 'batch';
    output.batch = await reconcileGooglePlayEntitlementBatch({
      limit: args.batchSize,
      now,
      lookbackDays: args.lookbackDays,
      dryRun: Boolean(args.dryRun),
      dependencies,
    });
  }

  if (args.retryNotifications) {
    output.mode = output.mode ? `${output.mode}+retry-notifications` : 'retry-notifications';
    output.retryNotifications = await retryDueGoogleRtdnInbox({
      limit: args.batchSize,
      now,
      dependencies,
    });
  }

  output.completedAt = new Date().toISOString();
  return output;
}

if (require.main === module) {
  run()
    .then((output) => {
      console.log(JSON.stringify(output, null, 2));
    })
    .catch((error) => {
      const safe = toSafeError(error);
      console.error(JSON.stringify(safe, null, 2));
      process.exitCode = error instanceof GooglePlayReconciliationError ? 2 : 1;
    });
}

module.exports = {
  parseArgs,
  run,
};
