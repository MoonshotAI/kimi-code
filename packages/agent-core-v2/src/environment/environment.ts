import type { Event } from '#/_base/event';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IHostTerminalService } from '#/os/interface/terminal';

export type EnvironmentStatus = 'connecting' | 'ready' | 'degraded' | 'disconnected' | 'draining' | 'disposed';
export type EnvironmentCapability = 'fs' | 'process' | 'terminal';

export const LOCAL_ENVIRONMENT_ID = 'local';

export interface EnvironmentBinding {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly cwd?: string;
}

export interface EnvironmentIdentity {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly generation: string;
}

export interface EnvironmentPath {
  readonly separator: '/' | '\\';
  readonly delimiter: ':' | ';';
  isAbsolute(path: string): boolean;
  join(...paths: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: readonly string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
}

export interface EnvironmentWorkspaceRoots {
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface EnvironmentWorkspaceMapper {
  mapRoots(roots: EnvironmentWorkspaceRoots): EnvironmentWorkspaceRoots;
}

export interface Environment {
  readonly identity: EnvironmentIdentity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host: HostEnvironmentInfo;
  readonly path: EnvironmentPath;
  readonly workspace: EnvironmentWorkspaceMapper;
  readonly fs?: IHostFileSystem;
  readonly process?: IHostProcessService;
  readonly terminal?: IHostTerminalService;
  readonly status: EnvironmentStatus;
  readonly onDidChangeStatus: Event<EnvironmentStatus>;
  readonly whenReady?: Promise<void>;
  readonly connectError?: string;
  connect?(): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface EnvironmentLease {
  readonly environment: Environment;
  track<T extends { dispose(): void | Promise<void> }>(resource: T): T;
  dispose(): void;
}
