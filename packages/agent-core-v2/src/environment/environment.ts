import type { Event } from '#/_base/event';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IHostTerminalService } from '#/os/interface/terminal';

export type EnvironmentStatus = 'pending' | 'connecting' | 'ready' | 'disconnected' | 'disposed';
export type EnvironmentCapability = 'fs' | 'process' | 'terminal';

export const LOCAL_ENVIRONMENT_ID = 'local';

export function resolvedEnvironmentId(
  input: { readonly environment_id?: string; readonly runtime_id?: string },
  fallback: string,
): string;
export function resolvedEnvironmentId(
  input: { readonly environment_id?: string; readonly runtime_id?: string },
  fallback?: string,
): string | undefined;
export function resolvedEnvironmentId(
  input: { readonly environment_id?: string; readonly runtime_id?: string },
  fallback?: string,
): string | undefined {
  return input.environment_id ?? input.runtime_id ?? fallback;
}

export interface EnvironmentBinding {
  readonly environmentId: string;
  readonly cwd?: string;
}

export function environmentBindingId(environmentId: string, cwd?: string): string {
  return cwd === undefined ? environmentId : `${environmentId}\0${cwd}`;
}

export interface EnvironmentIdentity extends EnvironmentBinding {
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
  readonly host?: HostEnvironmentInfo;
  readonly path?: EnvironmentPath;
  readonly workspace?: EnvironmentWorkspaceMapper;
  readonly fs?: IHostFileSystem;
  readonly process?: IHostProcessService;
  readonly terminal?: IHostTerminalService;
  readonly status: EnvironmentStatus;
  readonly onDidChangeStatus: Event<EnvironmentStatus>;
  readonly whenReady?: Promise<void>;
  readonly connectError?: string;
  connect?(): Promise<void>;
  disconnect?(): void;
  dispose(): void | Promise<void>;
}

export interface EnvironmentLease {
  readonly environment: Environment;
  track<T extends { dispose(): void | Promise<void> }>(resource: T, sessionId?: string): T;
  dispose(): void;
}

export async function realpathExistingPrefix(
  fs: Pick<IHostFileSystem, 'realpath'>,
  path: EnvironmentPath,
  abs: string,
  isMissing: (error: unknown) => boolean,
): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (let i = 0; i < 256; i++) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.toReversed());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return abs;
}
