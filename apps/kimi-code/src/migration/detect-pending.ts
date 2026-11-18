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
  readonly plansSourceHome?: string;
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
    return null;
  }

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
