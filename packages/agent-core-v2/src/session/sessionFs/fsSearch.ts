/**
 * `sessionFs` domain (L2) — pure search/grep helpers.
 *
 * Fuzzy filename scoring, glob matching, grep-pattern compilation, and
 * ripgrep `--json` record parsing. No IO, no DI — plain functions so they can
 * be unit-tested directly. Ported from v1 `services/fs/fsSearchService.ts`.
 */

import type { FsGrepRequest } from './fs';

export function computeFuzzyScore(name: string, queryLower: string): number {
  if (queryLower.length === 0) return 0;
  const nameLower = name.toLowerCase();
  let nameIdx = 0;
  let matched = 0;
  for (const ch of queryLower) {
    const found = nameLower.indexOf(ch, nameIdx);
    if (found < 0) {
      matched = -1;
      break;
    }
    matched += 1;
    nameIdx = found + 1;
  }
  if (matched <= 0) return 0;
  let score = matched / queryLower.length;
  if (nameLower.startsWith(queryLower)) score = Math.min(1, score + 0.2);

  return Math.min(1, Math.max(0, score));
}

export function computeMatchPositions(
  pathStr: string,
  queryLower: string,
): number[] {
  if (queryLower.length === 0) return [];
  const lower = pathStr.toLowerCase();
  const out: number[] = [];
  let pos = 0;
  for (const ch of queryLower) {
    const found = lower.indexOf(ch, pos);
    if (found < 0) return [];
    out.push(found);
    pos = found + 1;
  }
  return out;
}

export function matchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(rel)) return true;
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function compileGrepPattern(req: FsGrepRequest): RegExp {
  const flags = req.case_sensitive ? 'g' : 'gi';
  const body = req.regex ? req.pattern : escapeRegExp(req.pattern);
  return new RegExp(body, flags);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

interface RgPathField {
  text?: string;
  bytes?: string;
}
interface RgLinesField {
  text?: string;
  bytes?: string;
}
export interface RgJsonRecord {
  type: 'begin' | 'end' | 'match' | 'context' | 'summary';
  data?: {
    path?: RgPathField;
    lines?: RgLinesField;
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

export function rgPath(p: RgPathField | undefined): string | undefined {
  if (p === undefined) return undefined;
  let raw: string | undefined;
  if (typeof p.text === 'string') {
    raw = p.text;
  } else if (typeof p.bytes === 'string') {
    try {
      raw = Buffer.from(p.bytes, 'base64').toString('utf-8');
    } catch {
      return undefined;
    }
  }
  if (raw === undefined) return undefined;

  if (raw.startsWith('./')) return raw.slice(2);
  return raw;
}

export function rgText(l: RgLinesField | undefined): string {
  if (l === undefined) return '';
  if (typeof l.text === 'string') return l.text;
  if (typeof l.bytes === 'string') {
    try {
      return Buffer.from(l.bytes, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return '';
}
