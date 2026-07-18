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
 *   - `./postinstall/ui.mjs` — `notify()` (with `/dev/tty` fallback),
 *     ANSI styling, the fixed-width box, and the five outcome
 *     renderers.
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
 *   5. Detect EVERY previous Python `kimi-cli` shim on the detection
 *      PATH (`detectLegacyShims`). Returns `[]` for fresh-install /
 *      no-op. Multiple results happen when the user has installed
 *      `kimi-cli` through more than one Python tool (uv + pipx, or
 *      sudo-pip + pip-user). PATH order is preserved.
 *   6. Pre-flight classify each shim (`classifyShim`) — pure
 *      filesystem inspection, no writes. Each shim ends up
 *      `renameable`, `consolidate`, `delete-only`, or `blocked`.
 *   7. Decide abort vs proceed against the WHOLE set:
 *      `findFirstResolvableKimi` walks PATH treating the actionable
 *      shims as gone and reports what wins:
 *        - `own` → proceed to execute.
 *        - `blocked-legacy` → a legacy we can't remove still wins.
 *          Surface `logMigrationBlocked` with sudo / admin
 *          instructions; touch nothing.
 *        - `foreign` → some `kimi` we don't recognize (a user's own
 *          file) wins. Surface `logForeignKimiInTheWay` asking the
 *          user to delete or rename their own file; touch nothing.
 *        - `none` → no `kimi` on PATH at all (our shim's bin dir
 *          isn't in the shell's PATH). Surface
 *          `logNewCliNotOnPath`; touch nothing.
 *   8. Execute. The FIRST classification in PATH order that we can
 *      touch becomes `kimi-legacy` (preserves what `kimi` referred
 *      to before this install). Each subsequent shim is `unlink`ed —
 *      keeping it as a dormant duplicate adds no value. If the
 *      first shim's `kimi-legacy` target is already user-managed,
 *      we delete `kimi` anyway (still achieves takeover) and tell
 *      the user we couldn't preserve a fallback. Extension is
 *      preserved on Windows (`kimi.exe` → `kimi-legacy.exe`).
 *   9. One end-of-orchestration notice (`logMigrationDone`)
 *      summarizes every action — renames, consolidates,
 *      delete-only, deletes, and harmless blocked leftovers. The
 *      takeover-success line only fires on this path because Step 7
 *      already certified it.
 *  10. The manager completes the install with its usual summary.
 *      This script always exits 0; any uncaught error is swallowed
 *      by the top-level `catch` so the install never fails because
 *      of the migration.
 */

import {
  detectPackageManager,
  findFirstResolvableKimi,
  isGlobalInstall,
  ownPackageRoot,
  postinstallPaths,
} from './postinstall/reach.mjs';
import {
  classifyShim,
  deleteShim,
  detectLegacyShims,
  renameInPlace,
} from './postinstall/migrate.mjs';
import {
  logForeignKimiInTheWay,
  logMigrationBlocked,
  logMigrationDone,
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

  // Step 4: detect EVERY previous Python `kimi-cli` shim on the
  // detection PATH. A user with both `uv tool install` and `pipx
  // install` would have two; we must address all of them or the
  // survivor still shadows the new CLI.
  const detections = await detectLegacyShims(ownRoot, paths.detection);
  if (detections.length === 0) return;

  // Step 5: pre-flight classify every shim WITHOUT touching the
  // filesystem yet. The orchestrator decides abort-or-proceed against
  // the whole set rather than discovering mid-loop that we got partway
  // and have to backtrack.
  const classifications = await Promise.all(
    detections.map(async (detection) => {
      const c = await classifyShim(detection.shimPath);
      return { ...c, detection };
    }),
  );

  // Step 6: figure out what wins PATH resolution once every shim we
  // CAN touch is treated as gone. Three possible blockers:
  //   - a legacy shim we couldn't classify as actionable (sudo/admin
  //     needed)
  //   - an unrelated `kimi` we don't recognize (a user's own wrapper
  //     script — they own the decision)
  //   - nothing resolves (our shim isn't on PATH at all)
  // For each we render a different notice and touch NOTHING. The
  // common-case fourth result is "our shim wins" — we proceed.
  const actionable = classifications.filter((c) => c.kind !== 'blocked');
  const blocked = classifications.filter((c) => c.kind === 'blocked');
  const actionableShimPaths = actionable.map((c) => c.shimPath);
  const allDetectedShimPaths = classifications.map((c) => c.shimPath);

  const blocker = await findFirstResolvableKimi(
    ownRoot,
    paths.reachability,
    actionableShimPaths,
    allDetectedShimPaths,
  );
  if (blocker.kind !== 'own') {
    if (blocker.kind === 'blocked-legacy') {
      logMigrationBlocked(blocked, actionable, pm);
    } else if (blocker.kind === 'foreign') {
      logForeignKimiInTheWay(blocker.path, pm);
    } else {
      // 'none' — our shim isn't on PATH at all.
      logNewCliNotOnPath(detections[0], pm);
    }
    return;
  }

  // Step 7: execute. The FIRST classification in PATH order that
  // we can touch becomes `kimi-legacy` (preserves what the user's
  // `kimi` used to refer to). Every subsequent shim is just
  // deleted — keeping it as a dormant duplicate adds no value.
  const renames = [];
  const consolidates = [];
  const skippedForeignTarget = [];
  const deletes = [];
  const errors = [];
  let preservedFirst = false;

  for (const c of classifications) {
    if (c.kind === 'blocked') continue; // already established harmless

    if (!preservedFirst) {
      preservedFirst = true;
      if (c.kind === 'renameable') {
        const r = await renameInPlace(c.shimPath, c.target);
        if (r.success) {
          renames.push(c);
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
      if (c.kind === 'consolidate') {
        const r = await deleteShim(c.shimPath);
        if (r.success) {
          consolidates.push(c);
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
      if (c.kind === 'delete-only') {
        const r = await deleteShim(c.shimPath);
        if (r.success) {
          skippedForeignTarget.push(c);
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
    } else {
      // Not the first actionable shim. Just delete it.
      const r = await deleteShim(c.shimPath);
      if (r.success) {
        deletes.push(c);
      } else {
        errors.push({ ...c, ...r });
      }
    }
  }

  // Step 8: one notice summarizing everything that happened. The
  // takeover-success language is only emitted when we know it's true
  // (we already passed the reachability gate above).
  logMigrationDone(
    {
      renames,
      consolidates,
      skippedForeignTarget,
      deletes,
      blockedHarmless: blocked,
      errors,
    },
    pm,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  notify(`[kimi-code] postinstall warning: ${message}`);
});
