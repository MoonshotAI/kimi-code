/**
 * `sessionExport` domain (L6) — session diagnostic export contract.
 *
 * Defines the App-scope `ISessionExportService`, which packages a persisted
 * session directory plus optional global diagnostics into a zip archive. The
 * service coordinates live Session/Agent scope flushing before reading the
 * on-disk state, while the export manifest stays a JSON data contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

export interface ExportSessionPayload {
  readonly sessionId: string;
  readonly outputPath?: string | undefined;
  /**
   * When true, the active global diagnostic log (`$KIMI_CODE_HOME/logs/kimi-code.log`)
   * is copied into the zip at `logs/global/kimi-code.log`. Off by default to
   * avoid bundling events from concurrent sessions / other projects.
   */
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string | undefined;
  readonly sessionLastActivity?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
  /** zip-relative path to the session diagnostic log when present. */
  readonly sessionLogPath?: string | undefined;
  /** zip-relative path to the bundled global diagnostic log (only when --include-global-log). */
  readonly globalLogPath?: string | undefined;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ISessionExportService {
  readonly _serviceBrand: undefined;

  export(input: ExportSessionPayload): Promise<ExportSessionResult>;
}

export const ISessionExportService: ServiceIdentifier<ISessionExportService> =
  createDecorator<ISessionExportService>('sessionExportService');
