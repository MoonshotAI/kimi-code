export interface SpineSpawnEvidence {
  readonly summary: string;
  readonly outcome: 'completed' | 'errored' | 'aborted';
  readonly diagnostic?: string;
}

export type SpineNodeKind = 'epoch' | 'startup' | 'task';

export interface SpineNode {
  readonly id: string;
  readonly kind: SpineNodeKind;
  readonly summary: string;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly memory?: string;
  readonly spawn?: SpineSpawnEvidence;
  readonly children: readonly SpineNode[];
}

export interface SpineState {
  readonly epochs: readonly SpineNode[];
  readonly openPath: readonly SpineNode[];
  readonly rootEpoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt?: number;
}

export const SPINE_VOID_OPENED_AT = -1;

export function spineChildId(parentId: string, childCount: number): string {
  return `${parentId}.${String(childCount + 1)}`;
}

export function spineCursor(state: SpineState): SpineNode {
  const cursor = state.openPath.at(-1);
  if (cursor === undefined) {
    throw new Error('Spine open path is empty; the tree must always contain a root epoch.');
  }
  return cursor;
}

export function findSpineNode(state: SpineState, id: string): SpineNode | undefined {
  for (const epoch of state.epochs) {
    const found = findInSpineNode(epoch, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findInSpineNode(node: SpineNode, id: string): SpineNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findInSpineNode(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function walkSpineNodes(state: SpineState): SpineNode[] {
  const out: SpineNode[] = [];
  const visit = (node: SpineNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const epoch of state.epochs) visit(epoch);
  return out;
}
