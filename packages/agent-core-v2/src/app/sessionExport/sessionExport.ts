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
  readonly includeGlobalLog?: boolean | undefined;
  readonly version: string;
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
  readonly sessionLogPath?: string | undefined;
  readonly globalLogPath?: string | undefined;
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
