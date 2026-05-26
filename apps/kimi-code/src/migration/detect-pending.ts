/**
 * Pre-TUI detection: decide whether a first-launch migration screen should be
 * shown. Cheap, synchronous-ish, no TTY required. Returns the MigrationPlan to
 * drive the screen, or null when there is nothing to offer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { detectMigration, type MigrationPlan } from '@moonshot-ai/migration-legacy';

export interface DetectPendingInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  /**
   * When true, skip the marker-based suppression (`.migrated-to-kimi-code` /
   * `.skip-migration-from-kimi-cli`). The explicit `kimi migrate` command sets
   * this so a deliberate invocation always runs regardless of prior runs.
   */
  readonly ignoreMarker?: boolean;
}

export async function detectPendingMigration(
  input: DetectPendingInput,
): Promise<MigrationPlan | null> {
  const { sourceHome, targetHome } = input;
  if (!existsSync(sourceHome)) return null;
  if (input.ignoreMarker !== true) {
    if (migrationAlreadyTargeted(join(sourceHome, '.migrated-to-kimi-code'), targetHome)) {
      return null;
    }
    if (existsSync(join(targetHome, '.skip-migration-from-kimi-cli'))) return null;
  }

  let plan: MigrationPlan;
  try {
    plan = await detectMigration({ sourcePath: sourceHome });
  } catch {
    // Detection failure must never block startup; skip the screen.
    return null;
  }

  // OAuth credentials are deliberately not migrated, so an install whose
  // only data is `credentials/*.json` has nothing to offer — kimi-code's own
  // /login flow will pick up the auth conversation when the user first uses
  // the app. Treat oauth-only as "nothing to migrate".
  const nothingToMigrate =
    plan.totalSessions === 0 &&
    !plan.hasConfig &&
    !plan.hasMcp &&
    !plan.hasUserHistory;
  if (nothingToMigrate) return null;

  return plan;
}

/**
 * True when the legacy `.migrated-to-kimi-code` marker records a migration
 * into *this* target home. A marker written for a different `KIMI_CODE_HOME`
 * must not suppress the prompt — that target has never received migrated data.
 * An unreadable/old marker without `target_path` is treated as "matches"
 * (conservative: do not re-prompt when the marker exists but is ambiguous).
 */
function migrationAlreadyTargeted(markerPath: string, targetHome: string): boolean {
  if (!existsSync(markerPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as { target_path?: unknown };
    if (typeof parsed.target_path !== 'string') return true;
    return resolve(parsed.target_path) === resolve(targetHome);
  } catch {
    return true;
  }
}
