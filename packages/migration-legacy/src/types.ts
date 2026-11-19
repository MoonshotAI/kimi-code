export interface MigrationPlan {
  readonly sourceHome: string;
  readonly hasConfig: boolean;
  readonly hasMcp: boolean;
  readonly hasUserHistory: boolean;
  readonly hasSkills: boolean;
  readonly skillsSourceHome?: string;
  readonly hasPlans: boolean;
  readonly oauthCredentials: readonly string[];
  readonly workdirs: readonly WorkDirEntry[];
  readonly detectedPlugins: readonly string[];
  readonly detectedMcpOauthServers: readonly string[];
  readonly totalSessions: number;
  readonly sessionScanFailures?: readonly SessionMigrationFailure[];
}

export interface SessionMigrationFailure {
  readonly sourcePath: string;
  readonly reason: string;
}

export interface WorkDirEntry {
  readonly oldHashDir: string;
  readonly workdirPath: string;
  readonly sessions: readonly SessionEntry[];
}

export interface SessionEntry {
  readonly uuid: string;
  readonly oldDir: string;
  readonly wireMtime: number;
}

export interface MigrationScope {
  readonly config: boolean;
  readonly mcp: boolean;
  readonly userHistory: boolean;
  readonly skills: boolean;
  readonly sessions: boolean;
}

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
    readonly droppedKeys: readonly string[];
    readonly configConflicts: readonly string[];
    readonly wroteSiblingDueToConflict: boolean;
    readonly wroteTuiSibling: boolean;
    readonly migratedHooks: number;
    readonly droppedHooks: number;
    readonly sourceUnreadable: boolean;
    readonly deviceIdCopied: boolean;
    readonly siblingContents: {
      readonly providers: readonly string[];
      readonly models: readonly string[];
      readonly hooks: number;
    };
  };
  readonly mcp: {
    readonly mergedServers: readonly string[];
    readonly keptNewForConflicts: readonly string[];
    readonly droppedServers: readonly string[];
    readonly wroteSiblingDueToConflict: boolean;
    readonly sourceUnreadable: boolean;
  };
  readonly userHistory: { readonly copied: number; readonly skippedExisting: number };
  readonly skills: { readonly copied: number; readonly skippedExisting: number };
  readonly plans: { readonly copied: number; readonly skippedExisting: number };
  readonly sessions: SessionsSummary;
}

export interface SessionsSummary {
  readonly scope: 'all' | 'config-only';
  readonly bucketsScanned: number;
  readonly bucketsSkippedNonlocalKaos: number;
  readonly bucketsSkippedNoWorkdirFound: number;
  readonly sessionsAttempted: number;
  readonly sessionsMigrated: number;
  readonly sessionsAlreadyMigrated: number;
  readonly sessionsSkippedPlaceholder: number;
  readonly sessionsSkippedEmpty: number;
  readonly sessionsSkippedMalformed: number;
  readonly sessionsFailed: readonly SessionMigrationFailure[];
  readonly sessionsConflicts: ReadonlyArray<{ readonly sourcePath: string; readonly targetPath: string }>;
}

export interface MigrationNotices {
  readonly mcpOauthServersRequiringReauth: readonly string[];
  readonly oauthLoginsRequiringRelogin: readonly string[];
  readonly detectedPlugins: readonly string[];
  readonly configConflictNotice: string | null;
  readonly tuiConflictNotice: string | null;
  readonly plansCopiedNotice: string | null;
}
