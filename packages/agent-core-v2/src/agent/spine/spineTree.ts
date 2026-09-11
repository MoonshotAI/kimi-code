import type { SpineNode, SpineNodeKind, SpineState } from './spineOps';

export interface SpineTreeNodeView {
  readonly id: string;
  readonly kind: SpineNodeKind;
  readonly summary: string;
  readonly closed: boolean;
  readonly memory: string | undefined;
  readonly archivePath: string | undefined;
  readonly tokenCost: number | undefined;
  readonly children: readonly SpineTreeNodeView[];
}

export interface SpineTreeView {
  readonly nodes: readonly SpineTreeNodeView[];
}

export interface SpineTreeViewInput {
  readonly currentUsed?: number;
  readonly baselines?: ReadonlyMap<string, number>;
  readonly finals?: ReadonlyMap<string, number>;
  readonly resolveArchivePath?: (id: string, epoch: boolean, closed: boolean) => string | undefined;
}

export function spineTreeViewFromState(
  state: SpineState,
  input: SpineTreeViewInput = {},
): SpineTreeView {
  const lastEpoch = state.epochs.length - 1;
  return {
    nodes: state.epochs.map((node, index) => spineNodeView(node, index < lastEpoch, input)),
  };
}

function spineNodeView(
  node: SpineNode,
  supersededEpoch: boolean,
  input: SpineTreeViewInput,
): SpineTreeNodeView {
  const closed = node.closedAt !== undefined || supersededEpoch;
  return {
    id: node.id,
    kind: node.kind,
    summary: node.summary,
    closed,
    memory: node.memory,
    archivePath: input.resolveArchivePath?.(node.id, node.kind === 'epoch', closed),
    tokenCost: nodeTokenCost(node, input),
    children: node.children.map((child) => spineNodeView(child, false, input)),
  };
}

export function renderTree(view: SpineTreeView, cursorId: string | undefined): string {
  const lines: string[] = [];
  for (const node of view.nodes) {
    renderNode(node, '', cursorId, lines);
  }
  if (lines.length === 0) return '(empty spine tree)';
  return lines.join('\n');
}

function renderNode(
  node: SpineTreeNodeView,
  indent: string,
  cursorId: string | undefined,
  lines: string[],
): void {
  const cursor = node.id === cursorId ? ' <== cursor' : '';
  const state = node.closed ? 'closed' : 'open';
  const cost = node.tokenCost === undefined ? '' : `, ~${formatTokens(node.tokenCost)}`;
  const archive = node.archivePath === undefined ? '' : `, archive: ${node.archivePath}`;
  lines.push(`${indent}${node.id} [${state}${cost}${archive}]${cursor} — ${node.summary}`);
  for (const child of node.children) {
    renderNode(child, `${indent}  `, cursorId, lines);
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}K`;
  return String(tokens);
}

function nodeTokenCost(node: SpineNode, input: SpineTreeViewInput): number | undefined {
  const baseline = input.baselines?.get(node.id);
  if (baseline === undefined) return undefined;
  const end = node.closedAt === undefined ? input.currentUsed : input.finals?.get(node.id);
  if (end === undefined) return undefined;
  return Math.max(0, end - baseline);
}
