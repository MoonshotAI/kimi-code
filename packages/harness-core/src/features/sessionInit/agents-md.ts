import { dirname, isAbsolute, join, normalize } from 'pathe';

import type { OsFsPort, OsHost } from '#/features/os/host/index';

export interface LoadedAgentsMd {
  readonly content: string;
  readonly paths: string[];
}

const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

async function isNonEmptyFile(fs: OsFsPort, path: string): Promise<boolean> {
  try {
    const content = await fs.readText(path, { errors: 'ignore' });
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

async function findGitRoot(fs: OsFsPort, cwd: string): Promise<string | undefined> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return undefined;
  let current = normalize(cwd);
  for (;;) {
    try {
      const stats = await fs.stat(join(current, '.git'));
      if (stats.isDirectory || stats.isFile) return current;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = normalize(workDir);
  for (;;) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.toReversed();
}

async function loadAgentsMdPaths(
  fs: OsFsPort,
  homeDir: string,
  workDir: string,
  brandHome?: string,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const collect = async (path: string): Promise<boolean> => {
    if (!(await isNonEmptyFile(fs, path))) return false;
    const key = normalize(path);
    if (seen.has(key)) return false;
    seen.add(key);
    found.push(key);
    return true;
  };

  await collect(join(brandHome ?? join(homeDir, '.kimi-code'), 'AGENTS.md'));
  for (const fileName of AGENTS_MD_PLAIN_NAMES) {
    if (await collect(join(homeDir, '.agents', fileName))) break;
  }

  const rootWorkDir = normalize(workDir);
  const projectRoot = (await findGitRoot(fs, rootWorkDir)) ?? rootWorkDir;
  for (const dir of dirsRootToLeaf(rootWorkDir, projectRoot)) {
    await collect(join(dir, '.kimi-code', 'AGENTS.md'));
    for (const fileName of AGENTS_MD_PLAIN_NAMES) {
      if (await collect(join(dir, fileName))) break;
    }
  }
  return found;
}

export async function loadAgentsMdDetailed(
  host: OsHost,
  workDir: string,
  brandHome?: string,
): Promise<LoadedAgentsMd> {
  await host.environment.ready;
  const paths = await loadAgentsMdPaths(host.fs, host.environment.homeDir, workDir, brandHome);
  const sections: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = (await host.fs.readText(path, { errors: 'ignore' })).trim();
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    sections.push(`<!-- From: ${path} -->\n${text}`);
  }
  return { content: sections.join('\n\n'), paths };
}
