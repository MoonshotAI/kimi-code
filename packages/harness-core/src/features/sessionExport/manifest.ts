import type { SessionJournalScan } from './scan';
import type { ExportSessionManifest, ShellEnvironment } from './sessionExport';

export interface ExportSessionManifestSummary {
  readonly id: string;
  readonly title?: string;
}

export function buildExportManifest(args: {
  readonly summary: ExportSessionManifestSummary;
  readonly now: Date;
  readonly version: string;
  readonly wireProtocolVersion?: string;
  readonly sessionScan: SessionJournalScan;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
  readonly webLogPath?: string;
  readonly desktopVersion?: string;
  readonly installSource?: string;
  readonly shellEnv?: ShellEnvironment;
}): ExportSessionManifest {
  return {
    sessionId: args.summary.id,
    exportedAt: args.now.toISOString(),
    kimiCodeVersion: args.version,
    wireProtocolVersion: args.wireProtocolVersion,
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
    workspaceDir: undefined,
    sessionLogPath: undefined,
    globalLogPath: args.globalLogPath,
    desktopLogPath: args.desktopLogPath,
    webLogPath: args.webLogPath,
    desktopVersion: args.desktopVersion,
    installSource: args.installSource,
    shellEnv: args.shellEnv,
  };
}
