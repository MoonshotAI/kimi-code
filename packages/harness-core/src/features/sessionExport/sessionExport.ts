export interface ShellEnvironment {
  readonly term?: string;
  readonly termProgram?: string;
  readonly termProgramVersion?: string;
  readonly multiplexer?: string;
  readonly shell?: string;
}

export interface ExportSessionInput {
  readonly sessionId: string;
  readonly outputPath?: string;
  readonly includeGlobalLog?: boolean;
  readonly includeDesktopLog?: boolean;
  readonly webLog?: string;
  readonly desktopVersion?: string;
  readonly installSource?: string;
  readonly shellEnv?: ShellEnvironment;
  readonly signal?: AbortSignal;
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion?: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string;
  readonly sessionLastActivity?: string;
  readonly title?: string;
  readonly workspaceDir?: string;
  readonly sessionLogPath?: string;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
  readonly webLogPath?: string;
  readonly desktopVersion?: string;
  readonly installSource?: string;
  readonly shellEnv?: ShellEnvironment;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly manifest: ExportSessionManifest;
}
