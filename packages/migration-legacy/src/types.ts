/**
 * Plan describing the contents detected under the source `~/.kimi/` directory.
 * Produced by detect(); consumed by runMigration().
 */
export interface MigrationPlan {
  readonly sourceHome: string;
  readonly hasConfig: boolean;
  readonly hasMcp: boolean;
  readonly hasUserHistory: boolean;
  readonly oauthCredentials: readonly string[]; // basenames found under credentials/
  readonly workdirs: readonly WorkDirEntry[];
  readonly detectedPlugins: readonly string[];
  readonly detectedMcpOauthServers: readonly string[];
  readonly totalSessions: number; // sum across workdirs (real, post-classify)
}

/**
 * One workdir bucket (`~/.kimi/sessions/<md5>/`) with reverse-looked-up
 * path from `~/.kimi/kimi.json`. Buckets with kaos != 'local' or no
 * workdir found are excluded from this list (they appear in counters).
 */
export interface WorkDirEntry {
  readonly oldHashDir: string; // absolute path to ~/.kimi/sessions/<md5>/
  readonly workdirPath: string; // resolved absolute filesystem path
  readonly sessions: readonly SessionEntry[];
}

export interface SessionEntry {
  readonly uuid: string;
  readonly oldDir: string; // absolute path
  readonly wireMtime: number; // unix-ms, for "recent" sort; 0 if unknown
}

/**
 * User-driven knobs for what gets migrated. `sessions: true` migrates every
 * real local session; `false` skips the sessions step entirely.
 */
export interface MigrationScope {
  readonly config: boolean;
  readonly mcp: boolean;
  readonly userHistory: boolean;
  readonly skills: boolean;
  readonly sessions: boolean;
}

/**
 * Output of a runMigration() call. Serialized verbatim to
 * `~/.kimi-code/migration-report.json` and surfaced in the terminal summary.
 */
export interface MigrationReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly migratorVersion: string;
  readonly source: string;
  readonly target: string;
  readonly summary: MigrationSummary;
  readonly notices: MigrationNotices;
}

export interface MigrationSummary {
  readonly config: {
    readonly migrated: boolean;
    readonly tuiExtracted: boolean;
    readonly droppedProviders: readonly string[];
    readonly droppedModels: readonly string[];
    /** Top-level keys dropped because kimi-code's config schema lacks them. */
    readonly droppedKeys: readonly string[];
    /**
     * Keys/sections where the existing target config and the kimi-cli config
     * both set a different value — the target's value was kept.
     */
    readonly configConflicts: readonly string[];
    /** A `config.toml` conflict forced a `config.migrated-from-kimi-cli.toml` sibling. */
    readonly wroteSiblingDueToConflict: boolean;
    /** A `tui.toml` conflict forced a `tui.migrated-from-kimi-cli.toml` sibling. */
    readonly wroteTuiSibling: boolean;
    /** Count of kimi-cli hook entries written into the LIVE target config. */
    readonly migratedHooks: number;
    /** Count of kimi-cli hook entries dropped because kimi-code's schema rejects them. */
    readonly droppedHooks: number;
    /**
     * When `wroteSiblingDueToConflict` is true, what landed in
     * `config.migrated-from-kimi-cli.toml` instead of the live `config.toml`.
     * The result screen surfaces these so the user knows what needs manual
     * merging. Empty in `overwrite` / `merge` modes.
     */
    readonly siblingContents: {
      readonly providers: readonly string[];
      readonly models: readonly string[];
      readonly hooks: number;
    };
  };
  readonly mcp: {
    readonly mergedServers: readonly string[];
    readonly keptNewForConflicts: readonly string[];
    /** Source servers dropped because kimi-code's MCP schema rejects them. */
    readonly droppedServers: readonly string[];
    /** Target `mcp.json` was unparseable; merged servers went to a sibling. */
    readonly wroteSiblingDueToConflict: boolean;
  };
  readonly userHistory: { readonly copied: number; readonly skippedExisting: number };
  readonly skills: { readonly copied: number; readonly skippedExisting: number };
  readonly sessions: SessionsSummary;
}

export interface SessionsSummary {
  readonly scope: 'all' | 'config-only';
  readonly bucketsScanned: number;
  readonly bucketsSkippedNonlocalKaos: number;
  readonly bucketsSkippedNoWorkdirFound: number;
  readonly sessionsAttempted: number;
  readonly sessionsMigrated: number;
  /** Sessions already imported by a previous run (idempotent re-run). */
  readonly sessionsAlreadyMigrated: number;
  readonly sessionsSkippedPlaceholder: number;
  readonly sessionsSkippedEmpty: number;
  readonly sessionsSkippedMalformed: number;
  readonly sessionsFailed: ReadonlyArray<{ readonly sourcePath: string; readonly reason: string }>;
  readonly sessionsConflicts: ReadonlyArray<{ readonly sourcePath: string; readonly targetPath: string }>;
}

export interface MigrationNotices {
  readonly mcpOauthServersRequiringReauth: readonly string[];
  /**
   * Basenames of kimi-cli OAuth logins (`~/.kimi/credentials/<name>.json`)
   * found at detection time. OAuth credentials are deliberately NOT migrated:
   * refresh tokens rotate server-side, so a copied credential breaks login for
   * whichever install refreshes second. The user must run `/login` in
   * kimi-code instead. Empty when the legacy install had no OAuth login.
   */
  readonly oauthLoginsRequiringRelogin: readonly string[];
  readonly detectedPlugins: readonly string[];
  readonly configConflictNotice: string | null;
  readonly tuiConflictNotice: string | null;
}
