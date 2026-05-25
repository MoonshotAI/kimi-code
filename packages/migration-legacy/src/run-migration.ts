import type {
  MigrationPlan,
  MigrationReport,
  MigrationScope,
  SessionsSummary,
} from './types.js';
import { migrateConfigStep } from './steps/config.js';
import { migrateMcpStep } from './steps/mcp.js';
import { migrateUserHistoryStep } from './steps/user-history.js';
import { migrateSkillsStep } from './steps/skills.js';
import { migrateSessionsStep } from './sessions/index.js';
import { writeReport } from './report.js';
import { writeMigrationErrorsLog } from './migration-errors-log.js';
import { appendMarkerRun, readMarker, writeMarker } from './marker.js';

const DEFAULT_MIGRATOR_VERSION = '0.1.1';

const CONFIG_CONFLICT_NOTICE =
  'Your existing config.toml could not be parsed; migrated copy saved to ~/.kimi-code/config.migrated-from-kimi-cli.toml — please review and merge manually.';

const TUI_CONFLICT_NOTICE =
  'Your existing tui.toml had user modifications; migrated copy saved to ~/.kimi-code/tui.migrated-from-kimi-cli.toml — please review and merge manually.';

export interface RunMigrationInput {
  readonly plan: MigrationPlan;
  readonly scope: MigrationScope;
  readonly source: string;
  readonly target: string;
  readonly migratorVersion?: string;
  readonly onProgress?: (msg: string) => void;
  readonly onSessionProgress?: (done: number, total: number) => void;
}

export async function runMigration(input: RunMigrationInput): Promise<MigrationReport> {
  const startedAt = new Date().toISOString();
  const version = input.migratorVersion ?? DEFAULT_MIGRATOR_VERSION;
  const log = (m: string): void => {
    input.onProgress?.(m);
  };

  const config = input.scope.config
    ? await migrateConfigStep({ sourceHome: input.source, targetHome: input.target })
    : {
        migrated: false,
        tuiExtracted: false,
        droppedProviders: [],
        droppedModels: [],
        droppedKeys: [],
        configConflicts: [],
        wroteSiblingDueToConflict: false,
        wroteTuiSibling: false,
        migratedHooks: 0,
        droppedHooks: 0,
        siblingContents: { providers: [], models: [], hooks: 0 },
      };
  log('config done');

  const mcp = input.scope.mcp
    ? await migrateMcpStep({ sourceHome: input.source, targetHome: input.target })
    : { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false };
  log('mcp done');

  const userHistory = input.scope.userHistory
    ? await migrateUserHistoryStep({ sourceHome: input.source, targetHome: input.target })
    : { copied: 0, skippedExisting: 0 };
  log('user-history done');

  const skills = input.scope.skills
    ? await migrateSkillsStep({ sourceHome: input.source, targetHome: input.target })
    : { copied: 0, skippedExisting: 0 };
  log('skills done');

  const sessions: SessionsSummary = input.scope.sessions
    ? await migrateSessionsStep({
        sourceHome: input.source,
        targetHome: input.target,
        onSessionProgress: input.onSessionProgress,
      })
    : emptyConfigOnlySessions();
  log('sessions done');

  const completedAt = new Date().toISOString();

  const report: MigrationReport = {
    startedAt,
    completedAt,
    migratorVersion: version,
    source: input.source,
    target: input.target,
    summary: {
      config,
      mcp,
      userHistory,
      skills,
      sessions,
    },
    notices: {
      mcpOauthServersRequiringReauth: input.plan.detectedMcpOauthServers,
      oauthLoginsRequiringRelogin: input.plan.oauthCredentials,
      detectedPlugins: input.plan.detectedPlugins,
      configConflictNotice: config.wroteSiblingDueToConflict ? CONFIG_CONFLICT_NOTICE : null,
      tuiConflictNotice: config.wroteTuiSibling ? TUI_CONFLICT_NOTICE : null,
    },
  };

  await writeReport(input.target, report);

  // Append this run's outcome (per-session diagnostics on failure, a marker
  // on success) to `migration-errors.log` — append-only cross-run record so a
  // user can share one log covering every retry attempt.
  await writeMigrationErrorsLog(input.target, {
    startedAt,
    failures: sessions.sessionsFailed,
  });

  const markerSummary: Record<string, unknown> = {
    config,
    mcp,
    userHistory,
    skills,
    sessions,
  };

  // Marker persistence is best-effort: the data migration and the target
  // report are already complete, so a marker write failure (e.g. a read-only
  // legacy home) must not turn a finished migration into a reported failure.
  // The only consequence is that detection re-prompts on a later launch.
  try {
    const existingMarker = await readMarker(input.source);
    if (existingMarker === undefined) {
      await writeMarker(input.source, {
        startedAt,
        completedAt,
        migratorVersion: version,
        summary: markerSummary,
        targetPath: input.target,
      });
    } else {
      await appendMarkerRun(input.source, {
        startedAt,
        completedAt,
        migratorVersion: version,
        summary: markerSummary,
        targetPath: input.target,
      });
    }
  } catch {
    // best-effort — see comment above
  }

  return report;
}

function emptyConfigOnlySessions(): SessionsSummary {
  return {
    scope: 'config-only',
    bucketsScanned: 0,
    bucketsSkippedNonlocalKaos: 0,
    bucketsSkippedNoWorkdirFound: 0,
    sessionsAttempted: 0,
    sessionsMigrated: 0,
    sessionsAlreadyMigrated: 0,
    sessionsSkippedPlaceholder: 0,
    sessionsSkippedEmpty: 0,
    sessionsSkippedMalformed: 0,
    sessionsFailed: [],
    sessionsConflicts: [],
  };
}
