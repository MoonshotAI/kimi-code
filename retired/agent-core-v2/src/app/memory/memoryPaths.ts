/**
 * Memory path resolution — disk layout for persistent memory files.
 *
 * Memory files live under `~/.kimi-code/memory/` and are organized by scope:
 * - `global/` — cross-project knowledge
 * - `projects/<projectId>/` — project-specific knowledge
 * - `sessions/<sessionId>/` — session-specific knowledge
 *
 * The projectId is derived from the cwd via a short hash, so the same
 * working directory always maps to the same project memory.
 */

import { join } from 'pathe';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryType = 'note' | 'decision' | 'pattern' | 'lesson' | 'reference';

export interface MemoryEntry {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
  readonly updatedAt: number;
}

export interface MemorySearchResult {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}

export function projectIdFromCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

export function memoryDir(homeDir: string): string {
  return join(homeDir, 'memory');
}

export function scopeDir(
  base: string,
  scope: MemoryScope,
  scopeId: string,
): string {
  if (scope === 'global') return join(base, 'global');
  if (scope === 'project') return join(base, 'projects', scopeId);
  return join(base, 'sessions', scopeId);
}

/**
 * Parse a relative path into scope components.
 * `global/foo.md` → { scope: 'global', scopeId: '', relPath: 'foo.md' }
 * `projects/abc123/foo.md` → { scope: 'project', scopeId: 'abc123', relPath: 'foo.md' }
 * `sessions/xyz/foo.md` → { scope: 'session', scopeId: 'xyz', relPath: 'xyz' }
 */
export function parseMemoryPath(
  relPath: string,
): { scope: MemoryScope; scopeId: string; fileName: string } | undefined {
  const parts = relPath.split('/');
  if (parts.length < 2) return undefined;
  if (parts[0] === 'global') {
    return { scope: 'global', scopeId: '', fileName: parts.slice(1).join('/') };
  }
  if (parts[0] === 'projects' && parts.length >= 3) {
    return { scope: 'project', scopeId: parts[1]!, fileName: parts.slice(2).join('/') };
  }
  if (parts[0] === 'sessions' && parts.length >= 3) {
    return { scope: 'session', scopeId: parts[1]!, fileName: parts.slice(2).join('/') };
  }
  return undefined;
}

/**
 * Extract a title from markdown content — first H1 heading, or the filename.
 */
export function extractTitle(body: string, fileName: string): string {
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match && h1Match[1]) return h1Match[1].trim();
  return fileName.replace(/\.md$/i, '');
}

/**
 * Detect memory type from markdown frontmatter or heading.
 * Falls back to 'note'.
 */
export function detectType(body: string): MemoryType {
  const fmMatch = body.match(/^---[\s\S]*?type:\s*(\w+)/m);
  if (fmMatch && fmMatch[1]) {
    const t = fmMatch[1] as MemoryType;
    if (isValidMemoryType(t)) return t;
  }
  const headingMatch = body.match(/^##\s+(decision|pattern|lesson|reference)/im);
  if (headingMatch && headingMatch[1]) {
    const t = headingMatch[1].toLowerCase() as MemoryType;
    if (isValidMemoryType(t)) return t;
  }
  return 'note';
}

function isValidMemoryType(t: string): boolean {
  return t === 'note' || t === 'decision' || t === 'pattern' || t === 'lesson' || t === 'reference';
}

/**
 * Build a snippet from the body — find the first matching line and
 * surround it with context. Simple alternative to FTS5 snippet().
 */
export function buildSnippet(body: string, query: string, maxLen = 200): string {
  const lowerBody = body.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerBody.indexOf(lowerQuery);
  if (idx === -1) {
    return body.slice(0, maxLen).trim();
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + lowerQuery.length + 80);
  let snippet = body.slice(start, end).trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < body.length) snippet = `${snippet}...`;
  return snippet;
}
