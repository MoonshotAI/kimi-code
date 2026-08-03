import { AGENT_WIRE_PROTOCOL_VERSION } from '../../agent/records';
import type { SessionWireScan } from '#/session/export/wire-scan';
import type { ExportSessionManifest, ShellEnvironment, SessionSummary } from '#/rpc/core-api';

export const WIRE_PROTOCOL_VERSION = AGENT_WIRE_PROTOCOL_VERSION;

export function buildExportManifest(args: {
  readonly summary: SessionSummary;
  readonly now: Date;
  readonly version: string;
  readonly wireProtocolVersion?: string | undefined;
  readonly sessionScan: SessionWireScan;
  readonly sessionLogPath?: string | undefined;
  readonly globalLogPath?: string | undefined;
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
    workspaceDir: args.summary.workDir,
    sessionLogPath: args.sessionLogPath,
    globalLogPath: args.globalLogPath,
    installSource: args.installSource,
    shellEnv: args.shellEnv,
  };
}
