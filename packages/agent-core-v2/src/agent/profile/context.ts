/**
 * `profile` domain (L4) — system-prompt context assembly.
 *
 * Loads the AGENTS.md instruction hierarchy (user-level brand + generic files,
 * then project-level files from the project root down to the cwd) and assembles
 * the {@link SystemPromptContext} bag consumed by `IAgentProfileService.useProfile`.
 *
 * Runs on top of the os `IHostFileSystem` (for `readText` / `stat` / `readdir`)
 * plus the host's `homeDir` — supplied together as a small `ProfileContextDeps`
 * bag threaded through the helpers.
 *
 * Port of v1 `packages/agent-core/src/profile/context.ts`. The combined
 * AGENTS.md content is injected in full; when it exceeds the soft
 * {@link AGENTS_MD_RECOMMENDED_MAX_BYTES} budget a visible `agentsMdWarning`
 * is produced (surfaced through `getSessionWarnings`) instead of silently
 * truncating.
 */

import { dirname, join, normalize } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { SystemPromptContext } from './profile';

export const AGENTS_MD_RECOMMENDED_MAX_BYTES = 32 * 1024;

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

interface ProfileContextDeps {
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
}

export interface PreparedSystemPromptContext extends SystemPromptContext {
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly agentsMdWarning?: string;
}

export interface PrepareSystemPromptContextOptions {
  readonly additionalDirs?: readonly string[];
}

export async function prepareSystemPromptContext(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
  options?: PrepareSystemPromptContextOptions,
): Promise<PreparedSystemPromptContext> {
  const additionalDirs = dedupeDirs(options?.additionalDirs ?? []);
  const [cwdListing, agentsMdResult, additionalDirsInfo] = await Promise.all([
    listDirectory(deps, workDir, { collapseHiddenDirs: true }),
    loadAgentsMdForRoots(deps, brandHome, [workDir]),
    loadAdditionalDirsInfo(deps, additionalDirs),
  ]);
  return {
    cwdListing,
    agentsMd: agentsMdResult.content,
    additionalDirsInfo,
    agentsMdWarning: agentsMdResult.warning,
  };
}

export async function loadAgentsMd(
  deps: ProfileContextDeps,
  workDir: string,
  brandHome?: string,
): Promise<string> {
  const result = await loadAgentsMdForRoots(deps, brandHome, [workDir]);
  return result.content;
}

interface LoadedAgentsMd {
  readonly content: string;
  readonly warning: string | undefined;
}

async function loadAgentsMdForRoots(
  deps: ProfileContextDeps,
  brandHome: string | undefined,
  workDirs: readonly string[],
): Promise<LoadedAgentsMd> {
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(deps, path);
    if (file === undefined) return false;
    const key = normalize(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  const realHome = deps.homeDir;
  const brandDir = brandHome ?? join(realHome, '.kimi-code');
  await collect(join(brandDir, 'AGENTS.md'));

  const genericDirs = [join(realHome, '.agents')];
  const genericFiles = genericDirs.flatMap((dir) =>
    ['AGENTS.md', 'agents.md'].map((name) => join(dir, name)),
  );
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const workDir of workDirs) {
    const rootWorkDir = normalize(workDir);
    const projectRoot = await findProjectRoot(deps, rootWorkDir);
    const dirs = dirsRootToLeaf(rootWorkDir, projectRoot);

    for (const dir of dirs) {
      await collect(join(dir, '.kimi-code', 'AGENTS.md'));
      for (const fileName of ['AGENTS.md', 'agents.md']) {
        if (await collect(join(dir, fileName))) break;
      }
    }
  }

  const content = renderAgentFiles(discovered);
  const totalBytes = byteLength(content);
  const warning =
    totalBytes > AGENTS_MD_RECOMMENDED_MAX_BYTES
      ? `AGENTS.md total ${formatKB(totalBytes)} KB exceeds the recommended ` +
        `${formatKB(AGENTS_MD_RECOMMENDED_MAX_BYTES)} KB. Large instruction files ` +
        `increase cost and may impact performance; consider trimming.`
      : undefined;
  return { content, warning };
}

async function loadAdditionalDirsInfo(
  deps: ProfileContextDeps,
  additionalDirs: readonly string[],
): Promise<string> {
  const sections = await Promise.all(
    additionalDirs.map(async (dir) => {
      const listing = await listDirectory(deps, dir);
      return `### ${dir}\n${listing}`;
    }),
  );
  return sections.join('\n\n');
}

async function findProjectRoot(deps: ProfileContextDeps, workDir: string): Promise<string> {
  const initial = normalize(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(deps, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = normalize(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(
  deps: ProfileContextDeps,
  path: string,
): Promise<AgentFile | undefined> {
  if (!(await isFile(deps, path))) return undefined;
  const content = (await deps.fs.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) return undefined;
  return { path, content };
}

async function pathExists(deps: ProfileContextDeps, path: string): Promise<boolean> {
  try {
    await deps.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(deps: ProfileContextDeps, path: string): Promise<boolean> {
  try {
    const stat = await deps.fs.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `${annotationFor(file.path)}${file.content}`).join('\n\n');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}

function dedupeDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== 'string') continue;
    const trimmed = dir.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}


interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  deps: ProfileContextDeps,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    const dirents = await deps.fs.readdir(dirPath);
    for (const d of dirents) {
      all.push({ name: d.name, isDir: d.isDirectory });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function shouldCollapseDirectory(entry: Entry, options: ListDirectoryOptions): boolean {
  return options.collapseHiddenDirs === true && entry.isDir && entry.name.startsWith('.');
}

async function listDirectory(
  deps: ProfileContextDeps,
  workDir: string,
  options: ListDirectoryOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(deps, workDir, LIST_DIR_ROOT_WIDTH);
  if (!readable) return '[not readable]';
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { name, isDir } = entry;
    const isLast = i === entries.length - 1 && remaining === 0;
    const connector = isLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${connector}${name}/`);
      if (shouldCollapseDirectory(entry, options)) continue;
      const childPrefix = isLast ? '    ' : '│   ';
      const childDir = join(workDir, name);
      const child = await collectEntries(deps, childDir, LIST_DIR_CHILD_WIDTH);
      if (!child.readable) {
        lines.push(`${childPrefix}└── [not readable]`);
        continue;
      }
      const childRemaining = child.total - child.entries.length;
      for (let j = 0; j < child.entries.length; j++) {
        const ce = child.entries[j];
        if (ce === undefined) continue;
        const cIsLast = j === child.entries.length - 1 && childRemaining === 0;
        const cConnector = cIsLast ? '└── ' : '├── ';
        const suffix = ce.isDir ? '/' : '';
        lines.push(`${childPrefix}${cConnector}${ce.name}${suffix}`);
      }
      if (childRemaining > 0) {
        lines.push(`${childPrefix}└── ... and ${String(childRemaining)} more`);
      }
    } else {
      lines.push(`${connector}${name}`);
    }
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}
