import { ErrorCodes, Error2 } from '#/errors';
import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';

import type { Environment, EnvironmentBinding, EnvironmentPath, EnvironmentWorkspaceRoots } from './environment';
import { DEFAULT_ENVIRONMENT_HOST, POSIX_ENVIRONMENT_PATH, POSIX_ENVIRONMENT_WORKSPACE } from './environmentDefaults';

export type { EnvironmentWorkspaceRoots } from './environment';

export class EnvironmentWorkspaceView {
  readonly binding: EnvironmentBinding;
  readonly host: HostEnvironmentInfo;
  readonly path: EnvironmentPath;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly roots: readonly string[];

  constructor(
    readonly environment: Environment,
    roots: EnvironmentWorkspaceRoots,
  ) {
    this.binding = {
      workspaceId: environment.identity.workspaceId,
      environmentId: environment.identity.environmentId,
    };
    this.host = environment.host ?? DEFAULT_ENVIRONMENT_HOST;
    this.path = environment.path ?? POSIX_ENVIRONMENT_PATH;
    const workspace = environment.workspace ?? POSIX_ENVIRONMENT_WORKSPACE;
    const mapped = workspace.mapRoots(roots);
    this.workDir = this.path.resolve(mapped.workDir);
    this.additionalDirs = [...new Set((mapped.additionalDirs ?? []).map((root) => this.path.resolve(root)))];
    this.roots = [this.workDir, ...this.additionalDirs];
  }

  resolve(path: string, cwd = this.workDir): string {
    const bridged = this.host.pathClass === 'win32' ? getShellPathBridge(this.host).fromShellPath(path) : path;
    return this.path.isAbsolute(bridged)
      ? this.path.resolve(bridged)
      : this.path.resolve(cwd, bridged);
  }

  assertAllowed(path: string): string {
    const resolved = this.path.resolve(path);
    if (this.roots.some((root) => contains(this.path, root, resolved))) return resolved;
    throw new Error2(
      ErrorCodes.FS_PATH_ESCAPES,
      `path ${path} is outside environment workspace ${this.binding.environmentId}`,
      { details: { path: resolved } },
    );
  }
}

function contains(path: EnvironmentPath, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.separator}`) && !path.isAbsolute(relative);
}
