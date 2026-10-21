export type DiffStatus = 'unchanged' | 'added' | 'removed' | 'modified';

export interface DiffNode {
  readonly status: DiffStatus;
  readonly value: unknown;
  readonly prev: unknown;
  readonly children?: ReadonlyMap<string, DiffNode>;
}

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
