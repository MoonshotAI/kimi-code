/**
 * Pre-TUI detection: decide whether a first-launch migration screen should be
 * shown. Cheap, synchronous-ish, no TTY required. Returns the MigrationPlan to
 * drive the screen, or null when there is nothing to offer.
 */
import { existsSync } from 'node:fs';

import {
  detectMigration,
  shouldSuppressMigration,
  type MigrationPlan,
} from '@moonshot-ai/migration-legacy';

export interface DetectPendingInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly skillsSourceHome?: string;
  /**
   * kimi-cli keeps plan files at `~/.kimi/plans` regardless of KIMI_SHARE_DIR,
   * so detection reads them from the user's home by default. Injectable for
   * isolated tests.
   */
  readonly plansSourceHome?: string;
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
  if (
    input.ignoreMarker !== true &&
    shouldSuppressMigration({ sourceHome, targetHome })
  ) {
    return null;
  }

  let plan: MigrationPlan;
  try {
    plan = await detectMigration({
      sourcePath: sourceHome,
      skillsSourcePath: input.skillsSourceHome,
      plansSourcePath: input.plansSourceHome,
    });
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
    !plan.hasUserHistory &&
    !plan.hasSkills &&
    !plan.hasPlans &&
    (plan.sessionScanFailures?.length ?? 0) === 0;
  if (nothingToMigrate) return null;

  return plan;
}
