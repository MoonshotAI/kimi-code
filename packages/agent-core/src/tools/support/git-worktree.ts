/**
 * Marker-based git work-tree detection. Never spawns `git`; failures return
 * null so callers can fall back to their safer path.
 */

import * as pathe from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export interface GitWorkTreeMarker {
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export async function findGitWorkTreeMarker(
  kaos: Kaos,
  cwd: string,
): Promise<GitWorkTreeMarker | null> {
  if (cwd.length === 0 || !pathe.isAbsolute(cwd)) return null;

  let current = pathe.normalize(cwd);
  for (let depth = 0; depth < 256; depth += 1) {
    const dotGitPath = pathe.join(current, '.git');
    const hit = await probeGitMarker(kaos, dotGitPath, current);
    if (hit !== null) return hit;

    const parent = pathe.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function probeGitMarker(
  kaos: Kaos,
  dotGitPath: string,
  markerParent: string,
): Promise<GitWorkTreeMarker | null> {
  let stat: Awaited<ReturnType<Kaos['stat']>>;
  try {
    stat = await kaos.stat(dotGitPath);
  } catch {
    return null;
  }

  if (isMode(stat.stMode, S_IFDIR)) return { dotGitPath, controlDirPath: dotGitPath };
  if (!isMode(stat.stMode, S_IFREG)) return null;

  let content: string;
  try {
    content = await kaos.readText(dotGitPath);
  } catch {
    return null;
  }
  const controlDirPath = parseGitDir(content, markerParent);
  return controlDirPath === undefined ? null : { dotGitPath, controlDirPath };
}

function isMode(stMode: number, mode: number): boolean {
  return (stMode & S_IFMT) === mode;
}

/** Drop UTF-8 BOM and any leading whitespace (incl. `\r\n`) before content checks. */
function stripLeadingNoise(content: string): string {
  let s = content;
  if (s.codePointAt(0) === 0xfeff) s = s.slice(1);
  return s.trimStart();
}

function parseGitDir(
  content: string,
  markerParent: string,
): string | undefined {
  const line = stripLeadingNoise(content).split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;

  const rawPath = line.slice('gitdir:'.length).trim();
  if (rawPath.length === 0) return undefined;

  const absolute = pathe.isAbsolute(rawPath) ? rawPath : pathe.join(markerParent, rawPath);
  return pathe.normalize(absolute);
}
