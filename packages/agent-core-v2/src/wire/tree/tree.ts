import type { WireRecord } from '#/wire/record';

export const MAIN_BRANCH = 'main';
export const AGENT_SWITCHED_TYPE = 'agent.switched';

export interface WireLine {
  readonly record: WireRecord;
  readonly line: number;
}

export interface SwitchEdge {
  readonly line: number;
  readonly branch: string;
  readonly base: { readonly branch: string; readonly line: number };
  readonly reason?: string;
  readonly legacyUndoLine?: number;
}

export interface TreeSegment {
  readonly branch: string;
  readonly edge?: SwitchEdge;
  readonly fromLine: number;
  readonly toLine: number;
}

export interface TreeDiagnostics {
  readonly malformedSwitchLines: readonly number[];
  readonly duplicateBranches: readonly string[];
}

export interface WireTree {
  readonly edges: readonly SwitchEdge[];
  readonly segments: readonly TreeSegment[];
  readonly pairedLegacyUndoLines: ReadonlySet<number>;
  readonly activeBranch: string;
  readonly diagnostics: TreeDiagnostics;
}

function readSwitchEdge(record: WireRecord, line: number): SwitchEdge | undefined {
  if (record.type !== AGENT_SWITCHED_TYPE) return undefined;
  const branch = record['branch'];
  const base = record['base'];
  const reason = record['reason'];
  const legacyUndoLine = record['legacyUndoLine'];
  if (typeof branch !== 'string') return undefined;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return undefined;
  const baseBranch = (base as { branch?: unknown }).branch;
  const baseLine = (base as { line?: unknown }).line;
  if (typeof baseBranch !== 'string' || typeof baseLine !== 'number') return undefined;
  return {
    line,
    branch,
    base: { branch: baseBranch, line: baseLine },
    reason: typeof reason === 'string' ? reason : undefined,
    legacyUndoLine: typeof legacyUndoLine === 'number' ? legacyUndoLine : undefined,
  };
}

export function branchForLine(tree: WireTree, line: number): string {
  let owner = MAIN_BRANCH;
  for (const segment of tree.segments) {
    if (segment.fromLine > line) break;
    owner = segment.branch;
  }
  return owner;
}

export function parseTree(entries: readonly WireLine[], lastLine: number): WireTree {
  const edges: SwitchEdge[] = [];
  const pairedLegacyUndoLines = new Set<number>();
  const malformedSwitchLines: number[] = [];
  for (const { record, line } of entries) {
    if (record.type !== AGENT_SWITCHED_TYPE) continue;
    const edge = readSwitchEdge(record, line);
    if (edge === undefined) {
      malformedSwitchLines.push(line);
      continue;
    }
    edges.push(edge);
    if (edge.legacyUndoLine !== undefined) pairedLegacyUndoLines.add(edge.legacyUndoLine);
  }
  const segments: TreeSegment[] = [];
  const duplicateBranches: string[] = [];
  const seenBranches = new Set<string>([MAIN_BRANCH]);
  let branch = MAIN_BRANCH;
  let fromLine = 1;
  let opening: SwitchEdge | undefined;
  for (const edge of edges) {
    segments.push({ branch, edge: opening, fromLine, toLine: edge.line });
    if (seenBranches.has(edge.branch)) {
      if (!duplicateBranches.includes(edge.branch)) duplicateBranches.push(edge.branch);
    }
    seenBranches.add(edge.branch);
    branch = edge.branch;
    opening = edge;
    fromLine = edge.line + 1;
  }
  segments.push({ branch, edge: opening, fromLine, toLine: Math.max(lastLine, fromLine - 1) });
  return {
    edges,
    segments,
    pairedLegacyUndoLines,
    activeBranch: branch,
    diagnostics: { malformedSwitchLines, duplicateBranches },
  };
}

export function activeChain(entries: readonly WireLine[], tree: WireTree): WireLine[] {
  const segments = new Map(tree.segments.map((segment) => [segment.branch, segment]));
  const out: WireLine[] = [];
  const visited = new Set<string>();
  const walk = (branch: string, upto: number | undefined): void => {
    if (visited.has(branch)) {
      throw new Error(`agent.switched base chain cycles at branch '${branch}'`);
    }
    visited.add(branch);
    const segment = segments.get(branch);
    if (segment === undefined) {
      throw new Error(`agent.switched base chain references unknown branch '${branch}'`);
    }
    if (segment.edge !== undefined) walk(segment.edge.base.branch, segment.edge.base.line);
    const floor = segment.edge === undefined ? 1 : segment.edge.line + 1;
    const ceil = upto ?? segment.toLine;
    for (const entry of entries) {
      if (entry.record.type === AGENT_SWITCHED_TYPE) continue;
      if (entry.line < floor || entry.line > ceil) continue;
      out.push(entry);
    }
  };
  walk(tree.activeBranch, undefined);
  return out;
}
