import type { Event } from '#/_base/event';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IHostTerminalService } from '#/os/interface/terminal';

export type RuntimeStatus = 'connecting' | 'ready' | 'degraded' | 'disconnected' | 'draining' | 'disposed';
export type RuntimeCapability = 'fs' | 'process' | 'watch' | 'terminal';

export interface RuntimeBinding {
  readonly workspaceId: string;
  readonly runtimeId: string;
}

export interface RuntimeIdentity extends RuntimeBinding {
  readonly generation: string;
}

export interface RuntimePath {
  readonly separator: '/' | '\\';
  readonly delimiter: ':' | ';';
  isAbsolute(path: string): boolean;
  join(...paths: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: readonly string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
}

export interface RuntimeWorkspaceRoots {
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface RuntimeWorkspaceMapper {
  mapRoots(roots: RuntimeWorkspaceRoots): RuntimeWorkspaceRoots;
}

export interface Runtime {
  readonly identity: RuntimeIdentity;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment: HostEnvironmentInfo;
  readonly path: RuntimePath;
  readonly workspace: RuntimeWorkspaceMapper;
  readonly fs?: IHostFileSystem;
  readonly process?: IHostProcessService;
  readonly watch?: IHostFsWatchService;
  readonly terminal?: IHostTerminalService;
  readonly status: RuntimeStatus;
  readonly onDidChangeStatus: Event<RuntimeStatus>;
  dispose(): void | Promise<void>;
}

export interface RuntimeLease {
  readonly runtime: Runtime;
  track<T extends { dispose(): void | Promise<void> }>(resource: T): T;
  dispose(): void;
}
