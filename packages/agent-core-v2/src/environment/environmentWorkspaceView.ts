import { ErrorCodes, Error2 } from '#/errors';
import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';

import type { Environment, EnvironmentBinding, EnvironmentWorkspaceRoots } from './environment';

export type { EnvironmentWorkspaceRoots } from './environment';

export class EnvironmentWorkspaceView {
  readonly binding: EnvironmentBinding;
  readonly generation: string;
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
    this.generation = environment.identity.generation;
    const mapped = environment.workspace.mapRoots(roots);
    this.workDir = environment.path.resolve(mapped.workDir);
    this.additionalDirs = [...new Set((mapped.additionalDirs ?? []).map((root) => environment.path.resolve(root)))];
    this.roots = [this.workDir, ...this.additionalDirs];
  }

  resolve(path: string, cwd = this.workDir): string {
    const env = this.environment.host;
    const bridged = env.pathClass === 'win32' ? getShellPathBridge(env).fromShellPath(path) : path;
    return this.environment.path.isAbsolute(bridged)
      ? this.environment.path.resolve(bridged)
      : this.environment.path.resolve(cwd, bridged);
  }

  assertAllowed(path: string): string {
    const resolved = this.environment.path.resolve(path);
    if (this.roots.some((root) => contains(this.environment, root, resolved))) return resolved;
    throw new Error2(
      ErrorCodes.FS_PATH_ESCAPES,
      `path ${path} is outside environment workspace ${this.binding.environmentId}`,
      { details: { path: resolved } },
    );
  }
}

function contains(environment: Environment, root: string, candidate: string): boolean {
  const relative = environment.path.relative(root, candidate);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${environment.path.separator}`) && !environment.path.isAbsolute(relative);
}
