import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";

import {
  detectMigration,
  runMigration,
  shouldSuppressMigration,
  type MigrationPlan,
  type MigrationReport,
  type MigrationScope,
} from "@moonshot-ai/migration-legacy";

const FULL_MIGRATION_SCOPE = {
  config: true,
  mcp: true,
  userHistory: true,
  skills: true,
  sessions: true,
} satisfies MigrationScope;

export type LegacyMigrationSourceOrigin = "default" | "legacy-vscode-setting";

export type LegacyMigrationWarningCode =
  | "invalid-share-dir"
  | "relative-share-dir"
  | "source-equals-target"
  | "source-not-directory"
  | "source-unreadable"
  | "legacy-session-unreadable"
  | "detection-failed";

export interface LegacyMigrationWarning {
  readonly code: LegacyMigrationWarningCode;
  readonly message: string;
  readonly sourceHome?: string;
}

export interface LegacyMigrationReauthItem {
  readonly sourceHome: string;
  readonly name: string;
}

export interface LegacyMigrationNotices {
  readonly oauthLoginsRequiringRelogin: readonly LegacyMigrationReauthItem[];
  readonly mcpOauthServersRequiringReauth: readonly LegacyMigrationReauthItem[];
}

export interface LegacyMigrationSourcePreview {
  readonly sourceHome: string;
  readonly origin: LegacyMigrationSourceOrigin;
  readonly hasConfig: boolean;
  readonly hasMcp: boolean;
  readonly hasUserHistory: boolean;
  readonly hasSkills: boolean;
  readonly totalSessions: number;
  readonly sessionIssues: number;
}

export interface LegacyMigrationPromptModel {
  readonly kind: "legacy-migration";
  readonly message: string;
  readonly actions: readonly [
    { readonly id: "now"; readonly label: "Migrate Now" },
    { readonly id: "later"; readonly label: "Later" },
  ];
  readonly sources: readonly LegacyMigrationSourcePreview[];
  readonly notices: LegacyMigrationNotices;
}

export interface LegacyMigrationDiscovery {
  readonly prompt: LegacyMigrationPromptModel | null;
  readonly suppressedSources: readonly LegacyMigrationSourcePreview[];
  readonly warnings: readonly LegacyMigrationWarning[];
  readonly notices: LegacyMigrationNotices;
}

export interface LegacyMigrationManagerOptions {
  /** Harness-resolved homeDir. */
  readonly targetHome: string;
  /** Defaults to the legacy kimi-cli home (`~/.kimi`). Injectable for isolated tests. */
  readonly defaultSourceHome?: string;
  /** First workspace root. Used only to resolve a relative legacy KIMI_SHARE_DIR. */
  readonly workspaceRoot?: string | null;
  /** The removed `kimi.environmentVariables` VS Code setting, read once for migration. */
  readonly legacyEnvironmentVariables?: unknown;
}

export type LegacyMigrationFailureCode =
  | "run-failed"
  | "legacy-config-unreadable"
  | "legacy-mcp-unreadable"
  | "session-failed";

export interface LegacyMigrationFailure {
  readonly code: LegacyMigrationFailureCode;
  readonly sourceHome: string;
  readonly item?: string;
  readonly message: string;
}

export interface LegacyMigrationTotals {
  readonly configFiles: number;
  readonly mcpServers: number;
  readonly userHistoryEntries: number;
  readonly skills: number;
  readonly sessions: number;
  readonly alreadyMigratedSessions: number;
  readonly skippedItems: number;
  readonly conflicts: number;
  readonly failures: number;
}

export interface LegacyMigrationSourceResult {
  readonly source: LegacyMigrationSourcePreview;
  readonly status: "completed" | "partial" | "failed";
  readonly report?: MigrationReport;
  readonly failures: readonly LegacyMigrationFailure[];
  readonly error?: unknown;
}

export interface LegacyMigrationRunResult {
  readonly status: "completed" | "partial" | "failed" | "nothing-to-migrate";
  readonly message: string;
  readonly sources: readonly LegacyMigrationSourceResult[];
  readonly suppressedSources: readonly LegacyMigrationSourcePreview[];
  readonly totals: LegacyMigrationTotals;
  readonly warnings: readonly LegacyMigrationWarning[];
  readonly notices: LegacyMigrationNotices;
  readonly manualActions: readonly string[];
}

interface InspectedSource {
  readonly preview: LegacyMigrationSourcePreview;
  readonly plan: MigrationPlan;
  readonly legacyMcpJsonValid: boolean;
}

interface InspectionResult {
  readonly pending: readonly InspectedSource[];
  readonly suppressed: readonly LegacyMigrationSourcePreview[];
  readonly warnings: readonly LegacyMigrationWarning[];
  readonly notices: LegacyMigrationNotices;
}

interface SourceCandidate {
  readonly sourceHome: string;
  readonly origin: LegacyMigrationSourceOrigin;
}

/**
 * Coordinates legacy kimi-cli migration for the VS Code host while keeping all
 * data translation inside the shared migration package.
 */
export class LegacyMigrationManager {
  readonly targetHome: string;

  private readonly defaultSourceHome: string;
  private readonly workspaceRoot: string | null;
  private readonly legacyEnvironmentVariables: unknown;

  constructor(options: LegacyMigrationManagerOptions) {
    if (options.targetHome.trim().length === 0) {
      throw new Error("LegacyMigrationManager requires a non-empty targetHome.");
    }
    this.targetHome = resolve(options.targetHome);
    this.defaultSourceHome = resolve(options.defaultSourceHome ?? join(homedir(), ".kimi"));
    this.workspaceRoot =
      options.workspaceRoot === undefined || options.workspaceRoot === null
        ? null
        : resolve(options.workspaceRoot);
    this.legacyEnvironmentVariables = options.legacyEnvironmentVariables;
  }

  /** Detect first-launch work without changing the source or target. */
  async discover(): Promise<LegacyMigrationDiscovery> {
    const inspection = await this.inspect(false);
    const sources = inspection.pending.map((source) => source.preview);
    return {
      prompt:
        sources.length === 0
          ? null
          : {
              kind: "legacy-migration",
              message:
                "Legacy Kimi data was found. Migrate config, MCP servers, history, skills, and sessions into Kimi Code? Your old data will be kept.",
              actions: [
                { id: "now", label: "Migrate Now" },
                { id: "later", label: "Later" },
              ],
              sources,
              notices: inspection.notices,
            },
      suppressedSources: inspection.suppressed,
      warnings: inspection.warnings,
      notices: inspection.notices,
    };
  }

  /** Run the migration selected from the first-launch prompt. */
  async migrateNow(): Promise<LegacyMigrationRunResult> {
    return this.execute(false);
  }

  /**
   * Explicit command-palette retry. Marker suppression is intentionally
   * bypassed because a completed marker may also describe a partially failed
   * run, while the shared migrator itself remains idempotent.
   */
  async retry(): Promise<LegacyMigrationRunResult> {
    return this.execute(true);
  }

  private async execute(ignoreMarker: boolean): Promise<LegacyMigrationRunResult> {
    const inspection = await this.inspect(ignoreMarker);
    const sourceResults: LegacyMigrationSourceResult[] = [];

    for (const source of inspection.pending) {
      try {
        const report = await runMigration({
          // The shared package owns its migration/schema version. It must not
          // be coupled to the VS Code extension's release version.
          plan: source.plan,
          scope: FULL_MIGRATION_SCOPE,
          source: source.preview.sourceHome,
          target: this.targetHome,
        });
        const failures = failuresFromReport(source, report);
        sourceResults.push({
          source: source.preview,
          status: failures.length === 0 ? "completed" : "partial",
          report,
          failures,
        });
      } catch (error) {
        sourceResults.push({
          source: source.preview,
          status: "failed",
          failures: [
            {
              code: "run-failed",
              sourceHome: source.preview.sourceHome,
              message: formatError(error),
            },
          ],
          error,
        });
      }
    }

    const status = runStatus(sourceResults);
    const totals = aggregateTotals(sourceResults);
    const manualActions = aggregateManualActions(sourceResults);
    return {
      status,
      message: runMessage(status, totals),
      sources: sourceResults,
      suppressedSources: inspection.suppressed,
      totals,
      warnings: inspection.warnings,
      notices: mergeRunNotices(inspection.notices, sourceResults),
      manualActions,
    };
  }

  private async inspect(ignoreMarker: boolean): Promise<InspectionResult> {
    const { candidates, warnings } = this.sourceCandidates();
    const pending: InspectedSource[] = [];
    const suppressed: LegacyMigrationSourcePreview[] = [];
    const oauthLoginsRequiringRelogin: LegacyMigrationReauthItem[] = [];
    const mcpOauthServersRequiringReauth: LegacyMigrationReauthItem[] = [];

    for (const candidate of candidates) {
      const sourceCheck = await checkSourceDirectory(candidate.sourceHome);
      if (sourceCheck === "missing") continue;
      if (sourceCheck === "not-directory") {
        warnings.push({
          code: "source-not-directory",
          sourceHome: candidate.sourceHome,
          message: `Legacy migration source is not a directory: ${candidate.sourceHome}`,
        });
        continue;
      }
      if (sourceCheck === "unreadable") {
        warnings.push({
          code: "source-unreadable",
          sourceHome: candidate.sourceHome,
          message: `Legacy migration source cannot be read: ${candidate.sourceHome}`,
        });
        continue;
      }

      let plan: MigrationPlan;
      try {
        plan = await detectMigration({ sourcePath: candidate.sourceHome });
      } catch (error) {
        warnings.push({
          code: "detection-failed",
          sourceHome: candidate.sourceHome,
          message: `Unable to inspect legacy data at ${candidate.sourceHome}: ${formatError(error)}`,
        });
        continue;
      }

      oauthLoginsRequiringRelogin.push(
        ...plan.oauthCredentials.map((name) => ({ sourceHome: candidate.sourceHome, name })),
      );
      mcpOauthServersRequiringReauth.push(
        ...plan.detectedMcpOauthServers.map((name) => ({
          sourceHome: candidate.sourceHome,
          name,
        })),
      );

      const hasSkills = await directoryHasEntries(join(candidate.sourceHome, "skills"));
      const sessionScanFailures = plan.sessionScanFailures ?? [];
      warnings.push(
        ...sessionScanFailures.map((failure) => ({
          code: "legacy-session-unreadable" as const,
          sourceHome: candidate.sourceHome,
          message: `${failure.reason} Source: ${failure.sourcePath}`,
        })),
      );
      const preview: LegacyMigrationSourcePreview = {
        sourceHome: candidate.sourceHome,
        origin: candidate.origin,
        hasConfig: plan.hasConfig,
        hasMcp: plan.hasMcp,
        hasUserHistory: plan.hasUserHistory,
        hasSkills,
        totalSessions: plan.totalSessions,
        sessionIssues: sessionScanFailures.length,
      };
      if (!hasMigratableData(preview)) continue;

      if (
        !ignoreMarker &&
        shouldSuppressMigration({
          sourceHome: candidate.sourceHome,
          targetHome: this.targetHome,
        })
      ) {
        suppressed.push(preview);
        continue;
      }

      pending.push({
        preview,
        plan,
        legacyMcpJsonValid: await isLegacyMcpJsonValid(plan, candidate.sourceHome),
      });
    }

    return {
      pending,
      suppressed,
      warnings,
      notices: {
        oauthLoginsRequiringRelogin: dedupeReauthItems(oauthLoginsRequiringRelogin),
        mcpOauthServersRequiringReauth: dedupeReauthItems(
          mcpOauthServersRequiringReauth,
        ),
      },
    };
  }

  private sourceCandidates(): {
    candidates: SourceCandidate[];
    warnings: LegacyMigrationWarning[];
  } {
    const warnings: LegacyMigrationWarning[] = [];
    const candidates: SourceCandidate[] = [
      { sourceHome: this.defaultSourceHome, origin: "default" },
    ];
    const shareDir = readLegacyShareDir(this.legacyEnvironmentVariables);

    if (shareDir.kind === "invalid") {
      warnings.push({
        code: "invalid-share-dir",
        message: shareDir.message,
      });
    } else if (shareDir.kind === "value") {
      let sourceHome: string | undefined;
      if (isAbsolute(shareDir.value)) {
        sourceHome = resolve(shareDir.value);
      } else if (this.workspaceRoot === null) {
        warnings.push({
          code: "invalid-share-dir",
          message:
            "The legacy KIMI_SHARE_DIR is relative, but no workspace is open; this migration source was ignored.",
        });
      } else {
        sourceHome = resolve(this.workspaceRoot, shareDir.value);
        warnings.push({
          code: "relative-share-dir",
          sourceHome,
          message: `The legacy relative KIMI_SHARE_DIR was resolved against the workspace: ${sourceHome}`,
        });
      }

      if (sourceHome !== undefined && samePath(sourceHome, this.targetHome)) {
        warnings.push({
          code: "source-equals-target",
          sourceHome,
          message: "The legacy KIMI_SHARE_DIR resolves to the Kimi Code home and was ignored.",
        });
      } else if (
        sourceHome !== undefined &&
        !candidates.some((candidate) => samePath(candidate.sourceHome, sourceHome))
      ) {
        candidates.push({ sourceHome, origin: "legacy-vscode-setting" });
      }
    }

    return { candidates, warnings };
  }
}

function readLegacyShareDir(
  environmentVariables: unknown,
): { readonly kind: "missing" } | { readonly kind: "value"; readonly value: string } | {
  readonly kind: "invalid";
  readonly message: string;
} {
  if (environmentVariables === undefined) return { kind: "missing" };
  if (
    typeof environmentVariables !== "object" ||
    environmentVariables === null ||
    Array.isArray(environmentVariables)
  ) {
    return {
      kind: "invalid",
      message: "The legacy kimi.environmentVariables setting is invalid and was ignored.",
    };
  }

  const value = (environmentVariables as Record<string, unknown>)["KIMI_SHARE_DIR"];
  if (value === undefined) return { kind: "missing" };
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      kind: "invalid",
      message: "The legacy KIMI_SHARE_DIR must be a non-empty string and was ignored.",
    };
  }
  return { kind: "value", value };
}

async function checkSourceDirectory(
  sourceHome: string,
): Promise<"ok" | "missing" | "not-directory" | "unreadable"> {
  try {
    const sourceStat = await stat(sourceHome);
    if (!sourceStat.isDirectory()) return "not-directory";
  } catch (error) {
    return isMissingError(error) ? "missing" : "unreadable";
  }

  try {
    await readdir(sourceHome);
    return "ok";
  } catch {
    return "unreadable";
  }
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function isLegacyMcpJsonValid(
  plan: MigrationPlan,
  sourceHome: string,
): Promise<boolean> {
  if (!plan.hasMcp) return true;
  try {
    JSON.parse(await readFile(join(sourceHome, "mcp.json"), "utf-8"));
    return true;
  } catch {
    return false;
  }
}

function hasMigratableData(source: LegacyMigrationSourcePreview): boolean {
  return (
    source.hasConfig ||
    source.hasMcp ||
    source.hasUserHistory ||
    source.hasSkills ||
    source.totalSessions > 0 ||
    source.sessionIssues > 0
  );
}

function failuresFromReport(
  source: InspectedSource,
  report: MigrationReport,
): LegacyMigrationFailure[] {
  const failures: LegacyMigrationFailure[] = [];
  if (source.plan.hasConfig && !report.summary.config.migrated) {
    failures.push({
      code: "legacy-config-unreadable",
      sourceHome: source.preview.sourceHome,
      item: "config.toml",
      message: "The legacy config.toml could not be read or parsed; review it manually.",
    });
  }
  if (source.plan.hasMcp && !source.legacyMcpJsonValid) {
    failures.push({
      code: "legacy-mcp-unreadable",
      sourceHome: source.preview.sourceHome,
      item: "mcp.json",
      message: "The legacy mcp.json could not be parsed; review it manually.",
    });
  }
  failures.push(
    ...report.summary.sessions.sessionsFailed.map((failure) => ({
      code: "session-failed" as const,
      sourceHome: source.preview.sourceHome,
      item: failure.sourcePath,
      message: failure.reason,
    })),
  );
  return failures;
}

function runStatus(
  sources: readonly LegacyMigrationSourceResult[],
): LegacyMigrationRunResult["status"] {
  if (sources.length === 0) return "nothing-to-migrate";
  if (sources.every((source) => source.status === "failed")) return "failed";
  if (sources.some((source) => source.status !== "completed")) return "partial";
  return "completed";
}

function aggregateTotals(sources: readonly LegacyMigrationSourceResult[]): LegacyMigrationTotals {
  let configFiles = 0;
  let mcpServers = 0;
  let userHistoryEntries = 0;
  let skills = 0;
  let sessions = 0;
  let alreadyMigratedSessions = 0;
  let skippedItems = 0;
  let conflicts = 0;
  let failures = 0;

  for (const source of sources) {
    failures += source.failures.length;
    const summary = source.report?.summary;
    if (summary === undefined) continue;
    configFiles += summary.config.migrated ? 1 : 0;
    mcpServers += summary.mcp.mergedServers.length;
    userHistoryEntries += summary.userHistory.copied;
    skills += summary.skills.copied;
    sessions += summary.sessions.sessionsMigrated;
    alreadyMigratedSessions += summary.sessions.sessionsAlreadyMigrated;
    skippedItems +=
      summary.userHistory.skippedExisting +
      summary.skills.skippedExisting +
      summary.sessions.sessionsSkippedPlaceholder +
      summary.sessions.sessionsSkippedEmpty +
      summary.sessions.sessionsSkippedMalformed;
    conflicts +=
      summary.config.configConflicts.length +
      summary.mcp.keptNewForConflicts.length +
      summary.sessions.sessionsConflicts.length;
  }

  return {
    configFiles,
    mcpServers,
    userHistoryEntries,
    skills,
    sessions,
    alreadyMigratedSessions,
    skippedItems,
    conflicts,
    failures,
  };
}

function aggregateManualActions(
  sources: readonly LegacyMigrationSourceResult[],
): readonly string[] {
  const actions: string[] = [];
  for (const source of sources) {
    for (const failure of source.failures) {
      if (failure.code === "run-failed") {
        actions.push(
          `Fix access to ${source.source.sourceHome} or the Kimi Code home, then run “Kimi Code: Migrate Legacy Data” again.`,
        );
      } else {
        actions.push(
          `${failure.message} Source: ${failure.item ?? source.source.sourceHome}`,
        );
      }
    }

    const summary = source.report?.summary;
    if (summary === undefined) continue;
    if (summary.config.wroteSiblingDueToConflict) {
      actions.push("Review and merge config.migrated-from-kimi-cli.toml.");
    }
    if (summary.config.wroteTuiSibling) {
      actions.push("Review and merge tui.migrated-from-kimi-cli.toml.");
    }
    if (summary.mcp.wroteSiblingDueToConflict) {
      actions.push("Review and merge mcp.migrated-from-kimi-cli.json.");
    }
    if (summary.sessions.sessionsConflicts.length > 0) {
      actions.push(
        `${summary.sessions.sessionsConflicts.length} legacy session(s) conflicted with existing target sessions and were kept unchanged.`,
      );
    }
  }
  return [...new Set(actions)];
}

function mergeRunNotices(
  detectionNotices: LegacyMigrationNotices,
  sources: readonly LegacyMigrationSourceResult[],
): LegacyMigrationNotices {
  const oauth = [...detectionNotices.oauthLoginsRequiringRelogin];
  const mcpOauth = [...detectionNotices.mcpOauthServersRequiringReauth];
  for (const source of sources) {
    const notices = source.report?.notices;
    if (notices === undefined) continue;
    oauth.push(
      ...notices.oauthLoginsRequiringRelogin.map((name) => ({
        sourceHome: source.source.sourceHome,
        name,
      })),
    );
    mcpOauth.push(
      ...notices.mcpOauthServersRequiringReauth.map((name) => ({
        sourceHome: source.source.sourceHome,
        name,
      })),
    );
  }
  return {
    oauthLoginsRequiringRelogin: dedupeReauthItems(oauth),
    mcpOauthServersRequiringReauth: dedupeReauthItems(mcpOauth),
  };
}

function dedupeReauthItems(
  items: readonly LegacyMigrationReauthItem[],
): readonly LegacyMigrationReauthItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${pathKey(item.sourceHome)}\0${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runMessage(
  status: LegacyMigrationRunResult["status"],
  totals: LegacyMigrationTotals,
): string {
  if (status === "nothing-to-migrate") return "No legacy Kimi data needs migration.";
  if (status === "failed") {
    return "Legacy migration failed. Fix the reported path or data error, then retry from the command palette.";
  }
  const migrated = `${totals.configFiles} config, ${totals.mcpServers} MCP server(s), ${totals.userHistoryEntries} history item(s), ${totals.skills} skill(s), and ${totals.sessions} session(s)`;
  if (status === "partial") {
    return `Legacy migration completed with ${totals.failures} failure(s): ${migrated}. Review the details and retry from the command palette.`;
  }
  return `Legacy migration complete: ${migrated}. Old data was kept.`;
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message || current.name);
    current = current.cause;
  }
  return messages.join(": ");
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  if (process.platform === "win32") return win32.resolve(path).toLowerCase();
  const windowsAbsolute = win32.isAbsolute(path);
  return windowsAbsolute ? win32.resolve(path).toLowerCase() : resolve(path);
}
