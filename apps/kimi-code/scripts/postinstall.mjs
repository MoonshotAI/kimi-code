#!/usr/bin/env node
import {
  detectPackageManager,
  isGlobalInstall,
  ownPackageRoot,
  postinstallPaths,
} from './postinstall/reach.mjs';
import {
  executeTakeover,
  planTakeover,
  verifyTakeover,
} from './postinstall/takeover.mjs';
import {
  logForeignKimiInTheWay,
  logMigrationBlocked,
  logMigrationDone,
  logMigrationIncomplete,
  logNewCliNotOnPath,
  notify,
} from './postinstall/ui.mjs';

async function main() {
  if (!isGlobalInstall()) return;

  const ownRoot = await ownPackageRoot(import.meta.dirname);
  const pm = detectPackageManager();

  const paths = await postinstallPaths();

  const plan = await planTakeover(
    ownRoot,
    paths.detection,
    paths.reachability,
    process.platform,
  );
  if (plan.kind === 'noop') return;
  if (plan.kind === 'blocked') {
    logMigrationBlocked(plan.blocked, plan.actionable, pm);
    return;
  }
  if (plan.kind === 'foreign') {
    logForeignKimiInTheWay(plan.path, pm);
    return;
  }
  if (plan.kind === 'not-on-path') {
    logNewCliNotOnPath(plan.detection, pm);
    return;
  }

  const outcomes = await executeTakeover(plan.classifications);

  const verify = await verifyTakeover(
    ownRoot,
    paths.reachability,
    plan.classifications.map((c) => c.shimPath),
    process.platform,
  );
  if (verify.kind === 'own') {
    logMigrationDone({ ...outcomes, blockedHarmless: plan.blocked }, pm);
    return;
  }
  logMigrationIncomplete({ outcomes, verify, blocked: plan.blocked }, pm);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  notify(`[kimi-code] postinstall warning: ${message}`);
});
