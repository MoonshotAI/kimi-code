import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { getShellPathBridge, type ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { ErrorCodes, Error2 } from '#/errors';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';

export interface HostWorkspaceRoots {
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface HostPath {
  readonly separator: '/' | '\\';
  readonly delimiter: ':' | ';';
  isAbsolute(path: string): boolean;
  join(...paths: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: readonly string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
}

export class HostWorkspaceView {
  readonly host: IHostEnvironment;
  readonly path: HostPath;
  readonly shellPathBridge: ShellPathBridge | undefined;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly roots: readonly string[];

  constructor(environment: IHostEnvironment, roots: HostWorkspaceRoots) {
    this.host = environment;
    const path = environment.pathClass === 'win32' ? win32Path : posixPath;
    this.path = {
      separator: path.sep,
      delimiter: path.delimiter,
      isAbsolute: (value) => path.isAbsolute(value),
      join: (...values) => path.join(...values),
      relative: (from, to) => path.relative(from, to),
      resolve: (...values) => path.resolve(...values),
      basename: (value) => path.basename(value),
      dirname: (value) => path.dirname(value),
    };
    this.shellPathBridge = getShellPathBridge(environment);
    this.workDir = this.path.resolve(roots.workDir);
    this.additionalDirs = [...new Set((roots.additionalDirs ?? []).map((root) => this.path.resolve(root)))];
    this.roots = [this.workDir, ...this.additionalDirs];
  }

  resolve(path: string, cwd = this.workDir): string {
    const bridged = this.shellPathBridge?.fromShellPath(path) ?? path;
    return this.path.isAbsolute(bridged) ? this.path.resolve(bridged) : this.path.resolve(cwd, bridged);
  }

  assertAllowed(path: string): string {
    const resolved = this.path.resolve(path);
    if (this.roots.some((root) => contains(this.path, root, resolved))) return resolved;
    throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path ${path} is outside workspace`, {
      details: { path: resolved },
    });
  }
}

function contains(path: HostPath, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.separator}`) && !path.isAbsolute(relative);
}
