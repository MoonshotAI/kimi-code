

import type { ServerLogLevel } from '../services/pinoLoggerService';


export interface InstallArgs {

  host: string;

  port: number;

  logLevel: ServerLogLevel;

  force?: boolean;
}


export interface InstallResult {
  status: 'installed' | 'replaced' | 'already-installed';
  message: string;

  plistPath?: string;

  unitPath?: string;

  taskName?: string;
}


export interface LifecycleResult {
  ok: boolean;

  message: string;
}


export interface ServiceStatus {

  platform: 'darwin' | 'linux' | 'win32';

  installed: boolean;

  running: boolean;

  pid?: number;

  port?: number;

  host?: string;

  logPath?: string;

  label?: string;

  unitName?: string;

  taskName?: string;

  notes?: readonly string[];
}


export interface ServiceManager {
  install(args: InstallArgs): Promise<InstallResult>;
  uninstall(): Promise<LifecycleResult>;
  start(): Promise<LifecycleResult>;
  stop(): Promise<LifecycleResult>;
  restart(): Promise<LifecycleResult>;
  status(): Promise<ServiceStatus>;
}


export class ServiceUnsupportedError extends Error {
  override readonly name = 'ServiceUnsupportedError';
  readonly code = 'ESERVICE_UNSUPPORTED' as const;
  readonly exitCode = 2 as const;
  readonly platform: string;
  constructor(platform: string) {
    super(`Kimi server service management is not yet supported on ${platform}.`);
    this.platform = platform;
  }
}


export class ServiceUnavailableError extends Error {
  override readonly name = 'ServiceUnavailableError';
  readonly code = 'ESERVICE_UNAVAILABLE' as const;
  readonly exitCode = 2 as const;
  readonly platform: string;

  constructor(platform: string, reason: string) {
    super(
      `${reason} Run \`kimi server run --port <port>\` directly when running inside Docker or another container supervisor.`,
    );
    this.platform = platform;
  }
}
