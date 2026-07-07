

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class FsPathEscapesError extends Error {
  readonly inputPath: string;
  readonly reason:
    | 'empty'
    | 'absolute'
    | 'dotdot_segment'
    | 'resolved_outside_cwd'
    | 'symlink_outside_cwd';

  constructor(
    inputPath: string,
    reason: FsPathEscapesError['reason'],
    detail?: string,
  ) {
    super(
      detail
        ? `path "${inputPath}" rejected (${reason}): ${detail}`
        : `path "${inputPath}" rejected (${reason})`,
    );
    this.name = 'FsPathEscapesError';
    this.inputPath = inputPath;
    this.reason = reason;
  }
}

export interface PathSafetyResult {

  readonly absolute: string;

  readonly relative: string;
}

export async function resolveSafePath(
  cwd: string,
  inputPath: string,
): Promise<PathSafetyResult> {

  if (inputPath === '' || inputPath === '/') {
    throw new FsPathEscapesError(inputPath, 'empty');
  }

  if (path.isAbsolute(inputPath)) {
    throw new FsPathEscapesError(inputPath, 'absolute');
  }

  const segments = inputPath.split(/[/\\]+/);
  if (segments.some((s) => s === '..')) {
    throw new FsPathEscapesError(inputPath, 'dotdot_segment');
  }

  const realCwd = await fs.realpath(cwd);

  const candidate = path.resolve(realCwd, inputPath);

  const resolved = await realpathLongestExistingPrefix(candidate);

  if (!isInsideOrEqual(resolved, realCwd)) {

    const reason: FsPathEscapesError['reason'] = isInsideOrEqual(candidate, realCwd)
      ? 'symlink_outside_cwd'
      : 'resolved_outside_cwd';
    throw new FsPathEscapesError(inputPath, reason, resolved);
  }

  return {
    absolute: resolved,
    relative: toPosixRelative(realCwd, resolved),
  };
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function realpathLongestExistingPrefix(target: string): Promise<string> {
  let current = target;
  const tailSegments: string[] = [];

  for (let i = 0; i < 4096; i++) {
    try {
      const real = await fs.realpath(current);

      tailSegments.reverse();
      return tailSegments.length === 0 ? real : path.join(real, ...tailSegments);
    } catch (err) {

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {

        return target;
      }
      tailSegments.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}

function toPosixRelative(cwd: string, absolute: string): string {
  if (absolute === cwd) return '.';
  const rel = path.relative(cwd, absolute);
  if (rel === '') return '.';

  return rel.split(path.sep).join('/');
}
