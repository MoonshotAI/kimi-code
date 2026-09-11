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

function nodeTokenCost(node: SpineNode, input: SpineTreeViewInput): number | undefined {
  const baseline = input.baselines?.get(node.id);
  if (baseline === undefined) return undefined;
  const end = node.closedAt === undefined ? input.currentUsed : input.finals?.get(node.id);
  if (end === undefined) return undefined;
  return Math.max(0, end - baseline);
}
