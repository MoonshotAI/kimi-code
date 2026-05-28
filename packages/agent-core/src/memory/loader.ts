import { basename, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

import type { TelemetryClient } from '../telemetry';
import { findProjectRoot } from './find-project-root';
import { parseMemoryFile } from './format';
import { isValidSlug } from './slug';
import type { MemoryEntry, MemoryIndex, MemoryScope } from './types';

export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
export { MEMORY_BODY_MAX_BYTES } from './format';

const RESERVED_FILENAME = 'MEMORY.md';
const INDEX_HEADER = '<!-- kimi-code memory index — v1 -->';
const INDEX_SUBHEADER = '<!-- Generated from per-fact .md files. Edit facts, not this section. -->';
const TRUNCATION_NOTE = (n: number): string =>
  `<!-- truncated: ${n} entries omitted; call Memory.list for the full set -->`;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

export async function loadMemory(
  kaos: Kaos,
  workDir: string,
  telemetry?: TelemetryClient,
): Promise<string> {
  const userRoot = join(kaos.gethome(), '.kimi-code', 'memory');
  const projectRoot = await findProjectRoot(kaos, workDir);
  const insideGitRepo = await hasGitDir(kaos, projectRoot);

  const bySlug = new Map<string, MemoryEntry>();
  await collectScope(kaos, 'user', userRoot, bySlug);
  if (insideGitRepo) {
    await collectScope(kaos, 'project', join(projectRoot, '.kimi-code', 'memory'), bySlug);
  }

  const entries = sortBySlug([...bySlug.values()]);
  const index = renderIndex(entries, MEMORY_INDEX_MAX_BYTES);
  if (index.droppedSlugs.length > 0 && telemetry !== undefined) {
    safeTrack(telemetry, 'memory_index_truncated', {
      droppedCount: index.droppedSlugs.length,
    });
  }
  return index.rendered;
}

function safeTrack(
  telemetry: TelemetryClient,
  event: string,
  properties: Readonly<Record<string, number | string | boolean | null>>,
): void {
  try {
    telemetry.track(event, properties);
  } catch {
    // fire-and-forget: telemetry sink errors must never disturb the caller.
  }
}

export function renderIndex(entries: readonly MemoryEntry[], budget: number): MemoryIndex {
  if (entries.length === 0) {
    return { rendered: '', entries: [], droppedSlugs: [] };
  }

  const project = entries.filter((e) => e.scope === 'project');
  const user = entries.filter((e) => e.scope === 'user');

  const droppedSlugs: string[] = [];
  let remainingProject = project;
  let remainingUser = user;
  let rendered = composeIndex(remainingProject, remainingUser, droppedSlugs.length);

  while (byteLength(rendered) > budget && remainingUser.length > 0) {
    const sorted = [...remainingUser].toSorted((a, b) =>
      b.record.name.localeCompare(a.record.name),
    );
    const dropped = sorted[0];
    if (dropped === undefined) break;
    droppedSlugs.push(dropped.record.name);
    remainingUser = remainingUser.filter((e) => e !== dropped);
    rendered = composeIndex(remainingProject, remainingUser, droppedSlugs.length);
  }

  while (byteLength(rendered) > budget && remainingProject.length > 0) {
    const sorted = [...remainingProject].toSorted((a, b) =>
      b.record.name.localeCompare(a.record.name),
    );
    const dropped = sorted[0];
    if (dropped === undefined) break;
    droppedSlugs.push(dropped.record.name);
    remainingProject = remainingProject.filter((e) => e !== dropped);
    rendered = composeIndex(remainingProject, remainingUser, droppedSlugs.length);
  }

  return {
    rendered,
    entries: [...remainingProject, ...remainingUser],
    droppedSlugs,
  };
}

async function collectScope(
  kaos: Kaos,
  scope: MemoryScope,
  root: string,
  out: Map<string, MemoryEntry>,
): Promise<void> {
  if (!(await isDir(kaos, root))) return;

  const paths: string[] = [];
  for await (const entryPath of kaos.iterdir(root)) paths.push(entryPath);
  paths.sort();

  for (const path of paths) {
    const name = basename(path);
    if (!name.endsWith('.md')) continue;
    if (name === RESERVED_FILENAME) continue;
    const slug = name.slice(0, -'.md'.length);
    if (!isValidSlug(slug)) continue;
    let text: string;
    try {
      text = await kaos.readText(path);
    } catch {
      continue;
    }
    const entry = parseMemoryFile(scope, path, text);
    if (entry === undefined) continue;
    out.set(slug, entry);
  }
}

function composeIndex(
  project: readonly MemoryEntry[],
  user: readonly MemoryEntry[],
  truncatedCount: number,
): string {
  const sections: string[] = [INDEX_HEADER, INDEX_SUBHEADER];

  if (project.length > 0) {
    const root = sectionRoot(project);
    sections.push('', `## Project (${root})`, ...project.map(renderLine));
  }
  if (user.length > 0) {
    const root = sectionRoot(user);
    sections.push('', `## User (${root})`, ...user.map(renderLine));
  }
  if (truncatedCount > 0) {
    sections.push('', TRUNCATION_NOTE(truncatedCount));
  }

  return `${sections.join('\n')}\n`;
}

function renderLine(entry: MemoryEntry): string {
  const { name, description, type } = entry.record;
  return `- [${name}](${name}.md) (${type}) — ${description}`;
}

function sectionRoot(entries: readonly MemoryEntry[]): string {
  const first = entries[0];
  if (first === undefined) return '';
  return first.path.replace(/\/[^/]+$/, '');
}

function sortBySlug(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return [...entries].toSorted((a, b) => a.record.name.localeCompare(b.record.name));
}

async function isDir(kaos: Kaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.stat(path);
    return (stat.stMode & S_IFMT) === S_IFDIR;
  } catch {
    return false;
  }
}

async function hasGitDir(kaos: Kaos, dir: string): Promise<boolean> {
  try {
    await kaos.stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
