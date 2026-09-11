import type { SpineNode, SpineNodeKind, SpineState } from './spineOps';

export interface SpineTreeNodeView {
  readonly id: string;
  readonly kind: SpineNodeKind;
  readonly summary: string;
  readonly closed: boolean;
  readonly memory: string | undefined;
  readonly archivePath: string | undefined;
  readonly children: readonly SpineTreeNodeView[];
}

export interface SpineTreeView {
  readonly nodes: readonly SpineTreeNodeView[];
}

export interface SpineTreeViewInput {
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
    children: node.children.map((child) => spineNodeView(child, false, input)),
  };
}
