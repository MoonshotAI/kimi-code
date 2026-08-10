/**
 * System-prompt runtime context gathering — local port of the node-sdk
 * `prepareSystemPromptContext` (G-1 consumption switch): the compact 2-level
 * cwd listing plus the merged AGENTS.md content from the user-level and
 * project-level roots. Kept behavior-identical to the SDK so the session
 * system prompt keeps production parity with the harness path.
 */
import { basename, dirname, join } from 'pathe';

import type { LocalKaos } from './kaos-local';

export interface PreparedSystemPromptContext {
  readonly cwdListing: string;
  readonly agentsMd: string;
  readonly additionalDirsInfo: string;
}

/**
 * Gather the runtime context the coder profile renderer needs: cwd listing,
 * merged AGENTS.md content (user-level files first so project-level overrides
 * win), and additional-dirs listings.
 */
export async function prepareSystemPromptContext(
  kaos: LocalKaos,
  brandHome?: string,
): Promise<PreparedSystemPromptContext> {
  const [cwdListing, agentsMd] = await Promise.all([
    listDirectory(kaos, undefined, { collapseHiddenDirs: true }),
    loadAgentsMdForRoots(kaos, brandHome, [kaos.getcwd()]),
  ]);
  return { cwdListing, agentsMd, additionalDirsInfo: '' };
}

async function loadAgentsMdForRoots(
  kaos: LocalKaos,
  brandHome: string | undefined,
  workDirs: readonly string[],
): Promise<string> {
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(kaos, path);
    if (file === undefined) return false;
    const key = kaos.normpath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  // User-level files come first so any project-level AGENTS.md overrides them.
  // The brand dir follows KIMI_CODE_HOME (default ~/.kimi-code); the generic
  // .agents dir stays under the real OS home so it can be shared across tools.
  const realHome = kaos.gethome();
  const brandDir = brandHome ?? join(realHome, '.kimi-code');
  await collect(join(brandDir, 'AGENTS.md'));

  // Generic user-level dir (.agents) matches skill discovery.
  const genericFiles = [join(realHome, '.agents', 'AGENTS.md'), join(realHome, '.agents', 'agents.md')];
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const workDir of workDirs) {
    const rootKaos = kaos.withCwd(workDir);
    const rootWorkDir = rootKaos.getcwd();
    const projectRoot = await findProjectRoot(rootKaos, rootWorkDir);
    const dirs = dirsRootToLeaf(rootKaos, rootWorkDir, projectRoot);

    for (const dir of dirs) {
      await collect(join(dir, '.kimi-code', 'AGENTS.md'));
      for (const fileName of ['AGENTS.md', 'agents.md']) {
        if (await collect(join(dir, fileName))) break;
      }
    }
  }

  return renderAgentFiles(discovered);
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(kaos: LocalKaos, path: string): Promise<AgentFile | undefined> {
  if (!(await isFile(kaos, path))) return undefined;
  const content = (await kaos.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) return undefined;
  return { path, content };
}

async function findProjectRoot(kaos: LocalKaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(kaos: LocalKaos, workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = kaos.normpath(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

async function pathExists(kaos: LocalKaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}

// POSIX file-type masks (S_IFMT / S_IFREG), inlined from the retired
// agent-core path-utils.
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

async function isFile(kaos: LocalKaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.stat(path);
    return (stat.stMode & S_IFMT) === S_IFREG;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `${annotationFor(file.path)}${file.content}`).join('\n\n');
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}

/* ------------------------------------------------------------------ */
/*  listDirectory — compact 2-level directory tree for LLM context     */
/* ------------------------------------------------------------------ */

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

export interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  kaos: LocalKaos,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    for await (const fullPath of kaos.iterdir(dirPath)) {
      const name = basename(fullPath);
      let isDir = false;
      try {
        const st = await kaos.stat(fullPath);
        // StatResult mirrors POSIX stat; derive the file type from the
        // mode bits (S_IFMT mask → S_IFDIR == 0o040000).
        isDir = (st.stMode & 0o170000) === 0o040000;
      } catch {
        // Unreadable entries keep isDir=false; still list the name.
      }
      all.push({ name, isDir });
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

export async function listDirectory(
  kaos: LocalKaos,
  workDir: string = kaos.getcwd(),
  options: ListDirectoryOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(kaos, workDir, LIST_DIR_ROOT_WIDTH);
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
      const child = await collectEntries(kaos, childDir, LIST_DIR_CHILD_WIDTH);
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
