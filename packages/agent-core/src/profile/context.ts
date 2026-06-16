import { dirname, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

import { listDirectory } from '../tools/support/list-directory';
import type { SystemPromptContext, WorktreeInfo } from './types';

export type { WorktreeInfo };

const AGENTS_MD_MAX_BYTES = 32 * 1024;
const AGENTS_MD_TRUNCATION_MARKER =
  '<!-- Some AGENTS.md files were truncated or omitted to fit the 32 KB budget -->';
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export type PreparedSystemPromptContext = Pick<
  SystemPromptContext,
  'cwdListing' | 'agentsMd' | 'worktreeInfo'
>;

export async function prepareSystemPromptContext(
  kaos: Kaos,
  brandHome?: string,
): Promise<PreparedSystemPromptContext> {
  const [cwdListing, agentsMd] = await Promise.all([
    listDirectory(kaos, undefined, { collapseHiddenDirs: true }),
    loadAgentsMd(kaos, brandHome),
  ]);
  return { cwdListing, agentsMd };
}

export function getWorktreeInfoFromSessionMetadata(metadata: {
  readonly custom: Record<string, unknown>;
}): WorktreeInfo | undefined {
  const custom = metadata.custom;
  const worktreePath = custom?.['worktreePath'];
  const parentRepoPath = custom?.['parentRepoPath'];
  if (typeof worktreePath === 'string' && typeof parentRepoPath === 'string') {
    return { worktreePath, parentRepoPath };
  }
  return undefined;
}

export async function loadAgentsMd(kaos: Kaos, brandHome?: string): Promise<string> {
  const workDir = kaos.getcwd();
  const projectRoot = await findProjectRoot(kaos, workDir);
  const dirs = dirsRootToLeaf(kaos, workDir, projectRoot);
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
  const genericDirs = [join(realHome, '.agents')];
  const genericFiles = genericDirs.flatMap((dir) =>
    ['AGENTS.md', 'agents.md'].map((name) => join(dir, name)),
  );
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const dir of dirs) {
    await collect(join(dir, '.kimi-code', 'AGENTS.md'));
    for (const fileName of ['AGENTS.md', 'agents.md']) {
      if (await collect(join(dir, fileName))) break;
    }
  }

  return renderAgentFiles(discovered);
}

async function findProjectRoot(kaos: Kaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(kaos: Kaos, workDir: string, projectRoot: string): string[] {
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

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(kaos: Kaos, path: string): Promise<AgentFile | undefined> {
  if (!(await isFile(kaos, path))) return undefined;
  const content = (await kaos.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) return undefined;
  return { path, content };
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(kaos: Kaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.stat(path);
    return (stat.stMode & S_IFMT) === S_IFREG;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';

  let remaining = AGENTS_MD_MAX_BYTES;
  let didTruncate = false;
  const budgeted: Array<AgentFile | undefined> = Array.from({ length: files.length });

  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    if (file === undefined) continue;

    const annotation = annotationFor(file.path);
    const separator = i < files.length - 1 ? '\n\n' : '';
    remaining -= byteLength(annotation) + byteLength(separator);
    if (remaining <= 0) {
      budgeted[i] = { path: file.path, content: '' };
      remaining = 0;
      didTruncate = true;
      continue;
    }

    let content = file.content;
    if (byteLength(content) > remaining) {
      content = truncateUtf8(content, remaining).trim();
      didTruncate = true;
    }
    remaining -= byteLength(content);
    budgeted[i] = { path: file.path, content };
  }

  const rendered = budgeted
    .filter((file): file is AgentFile => file !== undefined && file.content.length > 0)
    .map((file) => `${annotationFor(file.path)}${file.content}`)
    .join('\n\n');

  return didTruncate ? `${AGENTS_MD_TRUNCATION_MARKER}\n${rendered}` : rendered;
}

function truncateUtf8(text: string, maxBytes: number): string {
  let result = text;
  while (byteLength(result) > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}


