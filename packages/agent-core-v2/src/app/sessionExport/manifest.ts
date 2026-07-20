/**
 * `sessionExport` domain (L6) — export manifest builder.
 *
 * Produces the diagnostic `manifest.json` included in every exported session
 * archive. The manifest combines persisted session metadata, host/runtime
 * version facts, and wire-log activity timestamps discovered during export.
 */

import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';

import type {
  ExportSessionManifest,
  ShellEnvironment,
} from './sessionExport';
import type { SessionWireScan } from './wire-scan';

export interface ExportSessionManifestSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
}

export function buildExportManifest(args: {
  readonly summary: ExportSessionManifestSummary;
  readonly now: Date;
  readonly version: string;
  readonly wireProtocolVersion?: string | undefined;
  readonly sessionScan: SessionWireScan;
  readonly sessionLogPath?: string | undefined;
  readonly globalLogPath?: string | undefined;
  readonly webLogPath?: string;
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}): ExportSessionManifest {
  return {
    sessionId: args.summary.id,
    exportedAt: args.now.toISOString(),
    kimiCodeVersion: args.version,
    wireProtocolVersion: args.wireProtocolVersion ?? WIRE_PROTOCOL_VERSION,
    os: `${process.platform} ${process.arch}`,
    nodejsVersion: process.version.replace(/^v/, ''),
    sessionFirstActivity:
      args.sessionScan.firstActivityMs === undefined
        ? undefined
        : new Date(args.sessionScan.firstActivityMs).toISOString(),
    sessionLastActivity:
      args.sessionScan.lastActivityMs === undefined
        ? undefined
        : new Date(args.sessionScan.lastActivityMs).toISOString(),
    title: args.summary.title,
    workspaceDir: args.summary.workspaceDir,
    sessionLogPath: args.sessionLogPath,
    globalLogPath: args.globalLogPath,
    webLogPath: args.webLogPath,
    installSource: args.installSource,
    shellEnv: args.shellEnv,
  };
}
