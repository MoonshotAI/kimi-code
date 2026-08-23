import { ErrorCodes, Error2 } from '#/errors';
import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';

import type { Runtime, RuntimeBinding, RuntimeWorkspaceRoots } from './runtime';

export type { RuntimeWorkspaceRoots } from './runtime';

export class RuntimeWorkspaceView {
  readonly binding: RuntimeBinding;
  readonly generation: string;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly roots: readonly string[];

  constructor(
    readonly runtime: Runtime,
    roots: RuntimeWorkspaceRoots,
  ) {
    this.binding = {
      workspaceId: runtime.identity.workspaceId,
      runtimeId: runtime.identity.runtimeId,
    };
    this.generation = runtime.identity.generation;
    const mapped = runtime.workspace.mapRoots(roots);
    this.workDir = runtime.path.resolve(mapped.workDir);
    this.additionalDirs = [...new Set((mapped.additionalDirs ?? []).map((root) => runtime.path.resolve(root)))];
    this.roots = [this.workDir, ...this.additionalDirs];
  }

  resolve(path: string, cwd = this.workDir): string {
    const env = this.runtime.environment;
    const bridged = env.pathClass === 'win32' ? getShellPathBridge(env).fromShellPath(path) : path;
    const resolved = this.runtime.path.isAbsolute(bridged)
      ? this.runtime.path.resolve(bridged)
      : this.runtime.path.resolve(cwd, bridged);
    this.assertAllowed(resolved);
    return resolved;
  }

  assertAllowed(path: string): void {
    const resolved = this.runtime.path.resolve(path);
    if (this.roots.some((root) => contains(this.runtime, root, resolved))) return;
    throw new Error2(
      ErrorCodes.FS_PATH_ESCAPES,
      `path ${path} is outside runtime workspace ${this.binding.runtimeId}`,
      { details: { path: resolved } },
    );
  }
}

function contains(runtime: Runtime, root: string, candidate: string): boolean {
  const relative = runtime.path.relative(root, candidate);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${runtime.path.separator}`) && !runtime.path.isAbsolute(relative);
}
