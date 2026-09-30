#!/usr/bin/env node
/**
 * Postinstall hook for @moonshot-ai/kimi-code.
 *
 * Goal: when this package is installed globally, ensure typing `kimi`
 * invokes the new TypeScript CLI. The npm `package.json` bin field
 * installs a fresh `kimi` shim into the global bin dir; this script
 * removes any pre-existing `kimi` shim left behind by the previous
 * Python CLI (installed via `uv tool install`, `pipx install`,
 * `pip install`, etc.) that would otherwise shadow ours via PATH
 * ordering. The renamed shim is kept as `kimi-legacy` so users can
 * still invoke the old CLI if they want to fall back.
 *
 * ## Hard rules
 *
 *   - Only runs for global installs across npm, yarn (classic), and
 *     pnpm. Non-global installs (npx, local project deps, workspace
 *     bootstraps, `pnpm dlx`) are silent no-ops.
 *   - Never fails the install. Any error here is caught and reported,
 *     but the script always exits 0.
 *   - Does not touch a `kimi` we don't recognize as the previous
 *     Python CLI (matched by realpath-resolved shim head containing
 *     `kimi_cli`).
 *   - Cross-platform: POSIX and Windows. Windows-specific bits live
 *     in the helpers (PATHEXT-aware PATH walking, whole-file marker
 *     sniff for uv's Rust launcher .exe, extension-preserving
 *     rename target like `kimi.exe` → `kimi-legacy.exe`).
 *
 * ## Code layout
 *
 * This file is the orchestrator; the actual logic lives in
 * sibling modules to keep each file under a manageable size:
 *
 *   - `./postinstall/reach.mjs` — package-manager detection,
 *     global-install gate, own-package-root resolution, user-shell
 *     PATH lookup, reachability check.
 *   - `./postinstall/migrate.mjs` — legacy detection,
 *     `kimi`-vs-`kimi-legacy` classification, the rename / unlink
 *     primitives.
 *   - `./postinstall/takeover.mjs` — the plan → execute → verify
 *     state machine this orchestrator drives.
 *   - `./postinstall/ui.mjs` — `notify()` (with `/dev/tty` fallback),
 *     ANSI styling, the fixed-width box, and the outcome renderers.
 *
 * ## Workflow
 *
 * What runs when a user types `npm install -g @moonshot-ai/kimi-code`
 * (or the yarn / pnpm equivalent):
 *
 *   1. The manager extracts the package and runs lifecycle scripts.
 *      The `bin.kimi` mapping in `package.json` tells the manager to
 *      install a `kimi` shim under its global bin directory.
 *   2. The manager invokes this script via the `scripts.postinstall`
 *      entry — orchestrated by `main` below.
 *   3. Install-context gate: only proceed when this is a global
 *      install (`isGlobalInstall` checks `npm_config_global` /
 *      `pnpm_config_global` / `npm_config_location`).
 *   4. Probe PATH once via `postinstallPaths()`: detection uses the
 *      union of shell PATH + process PATH; reachability uses the
 *      shell PATH alone (with a fallback to process PATH if the
 *      shell can't be probed). Sharing one probe keeps detection
 *      and reachability symmetric and avoids running `$SHELL -l`
 *      twice.
 *   5. `planTakeover`: detect EVERY previous Python `kimi-cli` shim
 *      on the detection PATH, pre-flight classify each (no writes),
 *      and simulate PATH resolution with the actionable shims gone:
 *        - `own` wins → proceed.
 *        - a blocked legacy still wins → `logMigrationBlocked`.
 *        - a foreign `kimi` wins → `logForeignKimiInTheWay`.
 *        - nothing resolves → `logNewCliNotOnPath`.
 *      The abort branches touch NOTHING.
 *   6. `executeTakeover`: the FIRST shim in PATH order that can be
 *      preserved becomes `kimi-legacy`; each subsequent shim is
 *      `unlink`ed. A failed preserve attempt does not promote the
 *      next shim to deletion — it gets its own preserve attempt, so
 *      a usable legacy fallback survives whenever one is possible.
 *   7. `verifyTakeover`: walk the reachability PATH as it actually
 *      is AFTER execution. Only `{ kind: 'own' }` renders the
 *      success box (`logMigrationDone`); anything else renders
 *      `logMigrationIncomplete` — what changed, what still blocks,
 *      and how to finish by hand. The pre-flight simulation in
 *      step 5 is never reported as proof of success.
 *   8. The manager completes the install with its usual summary.
 *      This script always exits 0; any uncaught error is swallowed
 *      by the top-level `catch` so the install never fails because
 *      of the migration.
 */

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
  // Step 1: skip non-global installs (npx, local project deps,
  // workspace bootstraps). Windows is supported natively; the
  // platform-specific bits (PATHEXT-aware PATH walk, whole-file
  // marker sniff for uv's launcher .exe, extension-preserving
  // rename) live in the helpers.
  if (!isGlobalInstall()) return;

  // Step 2: locate our own installed package root once and share it
  // with both detection (skip files inside our package) and
  // reachability (only count our shim as "found").
  const ownRoot = await ownPackageRoot(import.meta.dirname);
  const pm = detectPackageManager();

  // Step 3: probe the user's shell PATH once so detection and
  // reachability share a single consistent view. Detection uses the
  // union of shell PATH + process PATH (so we catch a legacy shim
  // visible to either); reachability uses the shell PATH alone (so
  // we don't claim "kimi works now" when the shim only sits in the
  // installer's env).
  const paths = await postinstallPaths();

  // Step 4: plan against the whole detected shim set without writing.
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

  // Step 5: execute (preserve the first preservable shim as
  // `kimi-legacy`, delete the rest).
  const outcomes = await executeTakeover(plan.classifications);

  // Step 6: post-execution verification — the ONLY ground for a
  // success claim. If reality diverged from the step-4 simulation
  // (a rename failed, a new shim appeared), report it honestly.
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
