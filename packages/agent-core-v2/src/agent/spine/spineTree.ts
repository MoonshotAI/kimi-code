import type { SpineNode, SpineState } from './spineOps';

export const SPINE_VOID_OPENED_AT = -1;

export function nodeDepth(id: string): number {
  return id.split('.').length;
}

export function isRootEpoch(id: string): boolean {
  return nodeDepth(id) === 1;
}

export function parentNodeId(id: string): string | null {
  const last = id.lastIndexOf('.');
  return last < 0 ? null : id.slice(0, last);
}

export function childNodeId(parentId: string, childIndex: number): string {
  return `${parentId}.${String(childIndex)}`;
}

export function nextChildIndex(childIds: readonly string[]): number {
  return childIds.length + 1;
}

export function epochStartupNodeId(epoch: number): string {
  return `${String(epoch)}.1`;
}

export interface SpineTreeNodeView {
  readonly id: string;
  readonly summary: string;
  readonly closed: boolean;
  readonly archivePath: string | undefined;
  readonly tokenCost: number | undefined;
  readonly children: readonly SpineTreeNodeView[];
}

export interface SpineTreeRenderInput {
  readonly cursorId: string | undefined;
  readonly rootIds: readonly string[];
  readonly resolve: (id: string) => SpineTreeNodeView | undefined;
}

export function renderTree(input: SpineTreeRenderInput): string {
  const lines: string[] = [];
  for (const rootId of input.rootIds) {
    renderNode(rootId, '', input, lines);
  }
  if (lines.length === 0) return '(empty spine tree)';
  return lines.join('\n');
}

function renderNode(
  id: string,
  indent: string,
  input: SpineTreeRenderInput,
  lines: string[],
): void {
  const node = input.resolve(id);
  if (node === undefined) return;
  const cursor = id === input.cursorId ? ' <== cursor' : '';
  const state = node.closed ? 'closed' : 'open';
  const cost = node.tokenCost === undefined ? '' : `, ~${formatTokens(node.tokenCost)}`;
  const archive = node.archivePath === undefined ? '' : `, archive: ${node.archivePath}`;
  lines.push(`${indent}${id} [${state}${cost}${archive}]${cursor} — ${node.summary}`);
  const childIndent = `${indent}  `;
  for (const child of node.children) {
    renderNode(child.id, childIndent, input, lines);
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}K`;
  return String(tokens);
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
  return {
    nodes: epochRootIds(state)
      .map((id) => spineNodeViewFromState(state, id, input))
      .filter((node): node is SpineTreeNodeView => node !== undefined),
  };
}

export function spineNodeViewFromState(
  state: SpineState,
  id: string,
  input: SpineTreeViewInput = {},
): SpineTreeNodeView | undefined {
  const node = state.nodes[id];
  if (node === undefined) return undefined;
  const epoch = isRootEpoch(id);
  const supersededEpoch = epoch && id !== String(state.rootEpoch);
  const closed = node.closedAt !== undefined || supersededEpoch;
  return {
    id: node.id,
    summary: node.summary,
    closed,
    archivePath: input.resolveArchivePath?.(id, epoch, closed),
    tokenCost: nodeTokenCost(node, input),
    children: node.children
      .map((childId) => spineNodeViewFromState(state, childId, input))
      .filter((child): child is SpineTreeNodeView => child !== undefined),
  };
}

export function epochRootIds(state: SpineState): readonly string[] {
  return Object.keys(state.nodes)
    .filter((id) => isRootEpoch(id))
    .toSorted((a, b) => Number(a) - Number(b));
}

function nodeTokenCost(node: SpineNode, input: SpineTreeViewInput): number | undefined {
  const baseline = input.baselines?.get(node.id);
  if (baseline === undefined) return undefined;
  const end = node.closedAt === undefined ? input.currentUsed : input.finals?.get(node.id);
  if (end === undefined) return undefined;
  return Math.max(0, end - baseline);
}
