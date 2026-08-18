import type { FsGrepRequest } from '../fs';

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

export const VCS_METADATA_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.jj',
  '.svn',
  '.hg',
  '.bzr',
]);

export interface SuggestQuery {
  readonly nameQuery: string;
  readonly pathSegments: readonly string[];
  readonly showHidden: boolean;
  readonly followGitignore: boolean;
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
}

export interface SuggestCandidate {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly tier: number;
  readonly depth: number;
  readonly span: number;
  readonly score: number;
  readonly positions: readonly number[];
}

interface SuggestMatch {
  readonly tier: number;
  readonly span: number;
  readonly positions: number[];
}

function subsequencePositions(segment: string, query: string): number[] | null {
  const positions: number[] = [];
  let idx = 0;
  for (const ch of query) {
    const found = segment.indexOf(ch, idx);
    if (found < 0) return null;
    positions.push(found);
    idx = found + 1;
  }
  return positions;
}

function matchSuggestName(name: string, queryLower: string): SuggestMatch | null {
  const positions = subsequencePositions(name.toLowerCase(), queryLower);
  if (positions === null) return null;
  const nameLower = name.toLowerCase();
  const tier = nameLower === queryLower ? 3 : nameLower.startsWith(queryLower) ? 2 : 1;
  const span = positions[positions.length - 1]! - positions[0]! + 1;
  return { tier, span, positions };
}

function matchSuggestPath(path: string, querySegments: readonly string[]): SuggestMatch | null {
  const pathLower = path.toLowerCase();
  const pathSegments = pathLower.split('/');
  const offsets: number[] = [];
  let offset = 0;
  for (const seg of pathSegments) {
    offsets.push(offset);
    offset += seg.length + 1;
  }
  const positions: number[] = [];
  let nextSeg = 0;
  let lastSeg = -1;
  let lastSegPrefix = false;
  for (const querySeg of querySegments) {
    let matchedSeg = -1;
    let segPositions: number[] | null = null;
    for (let s = nextSeg; s < pathSegments.length; s++) {
      segPositions = subsequencePositions(pathSegments[s]!, querySeg);
      if (segPositions !== null) {
        matchedSeg = s;
        break;
      }
    }
    if (matchedSeg < 0 || segPositions === null) return null;
    for (const p of segPositions) positions.push(offsets[matchedSeg]! + p);
    lastSegPrefix = pathSegments[matchedSeg]!.startsWith(querySeg);
    lastSeg = matchedSeg;
    nextSeg = matchedSeg + 1;
  }
  const tier =
    pathLower === querySegments.join('/')
      ? 3
      : lastSeg === pathSegments.length - 1 && lastSegPrefix
        ? 2
        : 1;
  const span = positions[positions.length - 1]! - positions[0]! + 1;
  return { tier, span, positions };
}

export function evaluateSuggestCandidate(
  relPath: string,
  kind: 'file' | 'directory' | 'symlink',
  query: SuggestQuery,
): SuggestCandidate | null {
  const segments = relPath.split('/');
  if (segments.some((s) => VCS_METADATA_DIRS.has(s))) return null;
  if (!query.showHidden && segments.some((s) => s.startsWith('.'))) return null;
  const name = segments[segments.length - 1]!;
  const pathMode = query.pathSegments.length > 0;
  const match = pathMode
    ? matchSuggestPath(relPath, query.pathSegments)
    : matchSuggestName(name, query.nameQuery);
  if (match === null) return null;
  if (query.includeGlobs !== undefined && !matchesAnyGlob(relPath, query.includeGlobs)) return null;
  if (query.excludeGlobs !== undefined && matchesAnyGlob(relPath, query.excludeGlobs)) return null;
  const queryLength = pathMode
    ? query.pathSegments.reduce((total, seg) => total + seg.length, 0)
    : query.nameQuery.length;
  const raw =
    match.tier +
    0.5 / segments.length +
    0.25 * (queryLength / Math.max(name.length, 1)) +
    0.25 * (queryLength / Math.max(match.span, 1));
  const score = Math.min(1, raw / 4);
  const base = relPath.length - name.length;
  const positions = pathMode ? match.positions : match.positions.map((p) => base + p);
  return {
    path: relPath,
    name,
    kind,
    tier: match.tier,
    depth: segments.length,
    span: match.span,
    score,
    positions,
  };
}

export function compareSuggestCandidates(a: SuggestCandidate, b: SuggestCandidate): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  if (a.span !== b.span) return a.span - b.span;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

export class SuggestTopHeap {
  private readonly heap: SuggestCandidate[] = [];

  constructor(private readonly cap: number) {}

  get size(): number {
    return this.heap.length;
  }

  push(candidate: SuggestCandidate): void {
    if (this.cap <= 0) return;
    if (this.heap.length < this.cap) {
      this.heap.push(candidate);
      this.siftUp(this.heap.length - 1);
      return;
    }
    if (compareSuggestCandidates(this.heap[0]!, candidate) <= 0) return;
    this.heap[0] = candidate;
    this.siftDown(0);
  }

  drain(): SuggestCandidate[] {
    return this.heap.slice().sort(compareSuggestCandidates);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compareSuggestCandidates(this.heap[parent]!, this.heap[i]!) >= 0) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;
      if (
        left < this.heap.length &&
        compareSuggestCandidates(this.heap[left]!, this.heap[worst]!) > 0
      ) {
        worst = left;
      }
      if (
        right < this.heap.length &&
        compareSuggestCandidates(this.heap[right]!, this.heap[worst]!) > 0
      ) {
        worst = right;
      }
      if (worst === i) break;
      [this.heap[worst], this.heap[i]] = [this.heap[i]!, this.heap[worst]!];
      i = worst;
    }
  }
}
