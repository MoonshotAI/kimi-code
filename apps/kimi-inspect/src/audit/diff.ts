/**
 * Structural diff over serialized `AgentState` values (see `serialize.ts`).
 *
 * The audit panel diffs two adjacent, immutable states. Because the store
 * is copy-on-write, untouched subtrees share references — the reference
 * equality fast path below collapses them to `unchanged` without walking.
 *
 * Arrays of transcript entities are matched by their id field (turnId,
 * stepId, frameId, …) rather than by index, so an upsert in the middle of
 * the timeline does not turn into a cascade of spurious modifications.
 */

export type DiffStatus = 'unchanged' | 'added' | 'removed' | 'modified';

export interface DiffNode {
  readonly status: DiffStatus;
  /** Current value (`undefined` when removed). */
  readonly value: unknown;
  /** Previous value (`undefined` when added). */
  readonly prev: unknown;
  /**
   * Object/array children — key is the object key, the entity id, or
   * `#<index>` for plain arrays. Absent on leaves and on whole-subtree
   * added/removed nodes (the renderer colors the subtree as one block).
   */
  readonly children?: ReadonlyMap<string, DiffNode>;
}

/**
 * Id fields checked in priority order — MOST SPECIFIC FIRST. A step carries
 * both `turnId` and `stepId`, and a frame can carry `taskId` alongside its
 * `frameId`; matching the wrong one mislabels the node and, worse, collides
 * siblings in the children map (two steps of one turn both keyed `t1`).
 */
const ID_FIELDS = [
  'frameId',
  'stepId',
  'interactionId',
  'attachmentId',
  'todoId',
  'markerId',
  'refId',
  'turnId',
  'taskId',
] as const;

function elementId(element: unknown): string | undefined {
  if (typeof element !== 'object' || element === null) return undefined;
  for (const field of ID_FIELDS) {
    const value = (element as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Public for the audit UI: same id-priority keying used to match array elements. */
export { elementId };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containerStatus(children: ReadonlyMap<string, DiffNode>): DiffStatus {
  for (const child of children.values()) {
    if (child.status !== 'unchanged') return 'modified';
  }
  return 'unchanged';
}

function diffObjects(prev: Record<string, unknown>, next: Record<string, unknown>): DiffNode {
  const children = new Map<string, DiffNode>();
  for (const key of Object.keys(next)) {
    children.set(key, diffValue(prev[key], next[key]));
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) {
      children.set(key, { status: 'removed', value: undefined, prev: prev[key] });
    }
  }
  return { status: containerStatus(children), value: next, prev, children };
}

function diffArrays(prev: readonly unknown[], next: readonly unknown[]): DiffNode {
  const children = new Map<string, DiffNode>();
  const keyed =
    prev.every((el) => elementId(el) !== undefined) &&
    next.every((el) => elementId(el) !== undefined);

  if (keyed) {
    const prevById = new Map<string, unknown>();
    for (const el of prev) prevById.set(elementId(el) as string, el);
    const nextIds = new Set<string>();
    for (const el of next) {
      const id = elementId(el) as string;
      nextIds.add(id);
      children.set(id, diffValue(prevById.get(id), el));
    }
    for (const el of prev) {
      const id = elementId(el) as string;
      if (!nextIds.has(id)) children.set(id, { status: 'removed', value: undefined, prev: el });
    }
  } else {
    for (let i = 0; i < next.length; i += 1) {
      children.set(`#${i}`, diffValue(prev[i], next[i]));
    }
    for (let i = next.length; i < prev.length; i += 1) {
      children.set(`#${i}`, { status: 'removed', value: undefined, prev: prev[i] });
    }
  }
  return { status: containerStatus(children), value: next, prev, children };
}

export function diffValue(prev: unknown, next: unknown): DiffNode {
  if (prev === next) return { status: 'unchanged', value: next, prev };
  if (prev === undefined) return { status: 'added', value: next, prev: undefined };
  if (next === undefined) return { status: 'removed', value: undefined, prev };
  if (isPlainObject(prev) && isPlainObject(next)) return diffObjects(prev, next);
  if (Array.isArray(prev) && Array.isArray(next)) return diffArrays(prev, next);
  return { status: 'modified', value: next, prev };
}
