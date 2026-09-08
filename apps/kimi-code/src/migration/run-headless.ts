import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import {
  runMigration,
  type MigrationPlan,
  type MigrationReport,
  type MigrationScope,
} from '@moonshot-ai/migration-legacy';

import { detectPendingMigration } from './detect-pending';
import { resolveLegacySourceHome, sameLegacyPath } from './legacy-source';

export const MIGRATE_HEADLESS_EXIT = {
  success: 0,
  incomplete: 1,
  error: 2,
} as const;

export interface HeadlessMigrateDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly userHome: string;
  readonly cwd: string;
  readonly targetHome: string;
  readonly write: (line: string) => void;
}

export interface HeadlessMigrateInput {
  readonly configOnly: boolean;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function runHeadlessMigrate(
  input: HeadlessMigrateInput,
  deps?: Partial<HeadlessMigrateDeps>,
): Promise<number> {
  const resolved: HeadlessMigrateDeps = {
    env: deps?.env ?? process.env,
    userHome: deps?.userHome ?? homedir(),
    cwd: deps?.cwd ?? process.cwd(),
    targetHome: deps?.targetHome ?? resolveKimiHome(),
    write: deps?.write ?? defaultWrite,
  };
  const log = (msg: string): void => {
    resolved.write(`[kimi-migrate ${timestamp()}] ${msg}`);
  };

  const source = resolveLegacySourceHome(resolved.env, resolved.userHome, resolved.cwd);
  log(`source: ${source.sourceHome} (${source.origin === 'share-dir' ? 'KIMI_SHARE_DIR' : 'default ~/.kimi'})`);
  if (source.skillsSourceHome !== undefined) {
    log(`skills source: ${source.skillsSourceHome} (kimi-cli skills are not relocated by KIMI_SHARE_DIR)`);
  }
  log(`target: ${resolved.targetHome}`);

  if (sameLegacyPath(source.sourceHome, resolved.targetHome)) {
    log('error: source and target are the same directory; refusing to migrate');
    return MIGRATE_HEADLESS_EXIT.error;
  }

  const scope: MigrationScope = {
    config: true,
    mcp: true,
    userHistory: true,
    skills: true,
    sessions: !input.configOnly,
  };
  log(`scope: ${input.configOnly ? 'config-only (config, mcp, user-history, skills)' : 'full (config, mcp, user-history, skills, sessions)'}`);

  log('detecting legacy data…');
  const plansSourceHome = join(resolved.userHome, '.kimi', 'plans');
  const plan = await detectPendingMigration({
    sourceHome: source.sourceHome,
    skillsSourceHome: source.skillsSourceHome,
    targetHome: resolved.targetHome,
    plansSourceHome,
    ignoreMarker: true,
  });
  if (plan === null) {
    log(`nothing to migrate from ${source.sourceHome}`);
    return MIGRATE_HEADLESS_EXIT.success;
  }
  logPlan(plan, log);

  let report: MigrationReport;
  try {
    report = await runMigration({
      plan,
      scope,
      source: source.sourceHome,
      target: resolved.targetHome,
      plansSourceDir: plansSourceHome,
      onProgress: (msg) => log(`step: ${msg}`),
      onSessionProgress: (done, total) => log(`sessions: translating ${done}/${total}`),
    });
  } catch (error) {
    log(`error: migration crashed: ${error instanceof Error ? error.message : String(error)}`);
    return MIGRATE_HEADLESS_EXIT.error;
  }

  const complete = logReport(report, scope, log);
  log(`report written to ${resolved.targetHome}/migration-report.json`);
  log(`run log appended to ${resolved.targetHome}/migration-errors.log`);
  if (complete) {
    log('result: complete — completion marker written; future launches will not re-prompt');
    return MIGRATE_HEADLESS_EXIT.success;
  }
  log('result: incomplete — no completion marker; the next launch will offer migration again');
  return MIGRATE_HEADLESS_EXIT.incomplete;
}

function logPlan(plan: MigrationPlan, log: (msg: string) => void): void {
  const scanFailures = plan.sessionScanFailures?.length ?? 0;
  log(
    `detected: ${plan.totalSessions} sessions across ${plan.workdirs.length} workdirs` +
      ` · config=${plan.hasConfig} · mcp=${plan.hasMcp} · user-history=${plan.hasUserHistory} · skills=${plan.hasSkills}` +
      (scanFailures > 0 ? ` · ${scanFailures} unreadable session stores` : ''),
  );
  for (const failure of plan.sessionScanFailures ?? []) {
    log(`  unreadable: ${failure.sourcePath} — ${failure.reason}`);
  }
  if (plan.oauthCredentials.length > 0) {
    log(`oauth logins requiring re-login after migration: ${plan.oauthCredentials.join(', ')}`);
  }
  if (plan.detectedMcpOauthServers.length > 0) {
    log(`MCP servers requiring re-authentication: ${plan.detectedMcpOauthServers.join(', ')}`);
  }
  if (plan.detectedPlugins.length > 0) {
    log(`kimi-cli plugins (not migrated): ${plan.detectedPlugins.join(', ')}`);
  }
}

function logReport(
  report: MigrationReport,
  scope: MigrationScope,
  log: (msg: string) => void,
): boolean {
  const sum = report.summary;
  const c = sum.config;
  log(
    `config: migrated=${c.migrated} tui-extracted=${c.tuiExtracted}` +
      ` hooks-migrated=${c.migratedHooks} hooks-dropped=${c.droppedHooks}` +
      (c.droppedProviders.length > 0 ? ` dropped-providers=[${c.droppedProviders.join(', ')}]` : '') +
      (c.droppedModels.length > 0 ? ` dropped-models=[${c.droppedModels.join(', ')}]` : '') +
      (c.droppedKeys.length > 0 ? ` dropped-keys=[${c.droppedKeys.join(', ')}]` : '') +
      (c.configConflicts.length > 0 ? ` conflicts-kept-yours=[${c.configConflicts.join(', ')}]` : '') +
      (c.sourceUnreadable ? ' SOURCE-UNREADABLE' : ''),
  );
  if (c.wroteSiblingDueToConflict) {
    log(`config: live config.toml unparseable — migrated copy at config.migrated-from-kimi-cli.toml (${c.siblingContents.providers.length} providers, ${c.siblingContents.models.length} models, ${c.siblingContents.hooks} hooks)`);
  }
  if (c.wroteTuiSibling) {
    log('config: tui.toml conflicted — migrated copy at tui.migrated-from-kimi-cli.toml');
  }
  const m = sum.mcp;
  log(
    `mcp: merged=[${m.mergedServers.join(', ')}]` +
      (m.keptNewForConflicts.length > 0 ? ` kept-existing=[${m.keptNewForConflicts.join(', ')}]` : '') +
      (m.droppedServers.length > 0 ? ` dropped=[${m.droppedServers.join(', ')}]` : '') +
      (m.wroteSiblingDueToConflict ? ' wrote mcp.migrated-from-kimi-cli.json' : '') +
      (m.sourceUnreadable ? ' SOURCE-UNREADABLE' : ''),
  );
  log(`user-history: copied=${sum.userHistory.copied} skipped-existing=${sum.userHistory.skippedExisting}`);
  log(`skills: copied=${sum.skills.copied} skipped-existing=${sum.skills.skippedExisting}`);
  log(`plans: copied=${sum.plans.copied} skipped-existing=${sum.plans.skippedExisting}`);
  const s = sum.sessions;
  if (scope.sessions) {
    log(
      `sessions: scanned=${s.bucketsScanned} attempted=${s.sessionsAttempted} migrated=${s.sessionsMigrated}` +
        ` already-migrated=${s.sessionsAlreadyMigrated} skipped-empty=${s.sessionsSkippedEmpty}` +
        ` skipped-malformed=${s.sessionsSkippedMalformed} skipped-placeholder=${s.sessionsSkippedPlaceholder}` +
        ` failed=${s.sessionsFailed.length} conflicts=${s.sessionsConflicts.length}` +
        (s.bucketsSkippedNonlocalKaos > 0 ? ` buckets-skipped-nonlocal-kaos=${s.bucketsSkippedNonlocalKaos}` : '') +
        (s.bucketsSkippedNoWorkdirFound > 0 ? ` buckets-skipped-no-workdir=${s.bucketsSkippedNoWorkdirFound}` : ''),
    );
    for (const failure of s.sessionsFailed) {
      log(`  failed: ${failure.sourcePath} — ${failure.reason}`);
    }
    for (const conflict of s.sessionsConflicts) {
      log(`  conflict: ${conflict.sourcePath} — target occupied: ${conflict.targetPath}`);
    }
  }
  if (report.notices.oauthLoginsRequiringRelogin.length > 0) {
    log(`notice: run /login for: ${report.notices.oauthLoginsRequiringRelogin.join(', ')}`);
  }
  if (report.notices.mcpOauthServersRequiringReauth.length > 0) {
    log(`notice: re-authenticate MCP servers: ${report.notices.mcpOauthServersRequiringReauth.join(', ')}`);
  }
  if (report.notices.configConflictNotice !== null) {
    log(`notice: ${report.notices.configConflictNotice}`);
  }
  if (report.notices.tuiConflictNotice !== null) {
    log(`notice: ${report.notices.tuiConflictNotice}`);
  }
  if (report.notices.plansCopiedNotice !== null) {
    log(`notice: ${report.notices.plansCopiedNotice}`);
  }
  return (
    s.sessionsFailed.length === 0 &&
    s.sessionsConflicts.length === 0 &&
    !(scope.config && c.sourceUnreadable) &&
    !(scope.mcp && m.sourceUnreadable)
  );
}
