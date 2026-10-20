export interface Event {
  readonly type: string;
}

export interface Op<E extends Event> {
  readonly rewind?: number;
  readonly events?: readonly E[];
}

export interface Commit<E extends Event> extends Op<E> {
  readonly seq: number;
  readonly time: number;
}

export class LogCorruptError extends Error {
  constructor(detail: string, readonly line?: number) {
    super(line === undefined ? detail : `line ${line}: ${detail}`);
    this.name = 'LogCorruptError';
  }
}

const commitFields = new Set(['seq', 'time', 'rewind', 'events']);

export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEvent(value: unknown): value is Event {
  return isPlainObject(value) && typeof value['type'] === 'string' && value['type'].length > 0;
}

function assertJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError('Event numbers must be finite');
  }
  if (typeof value !== 'object') throw new TypeError(`Events must contain only JSON values, got ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError('Events must be acyclic');
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('Events must contain only plain objects and arrays');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, ancestors);
  } else {
    for (const item of Object.values(value)) if (item !== undefined) assertJson(item, ancestors);
  }
  ancestors.delete(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function encodeCommit<E extends Event>(commit: Commit<E>): string {
  if (!isSeq(commit.seq) || !isSeq(commit.time)) throw new TypeError('Commit seq and time must be non-negative integers');
  if (commit.rewind !== undefined && (!isSeq(commit.rewind) || commit.rewind > commit.seq)) {
    throw new TypeError(`Cannot rewind to ${String(commit.rewind)} at version ${commit.seq}`);
  }
  const events = commit.events ?? [];
  for (const event of events) {
    if (!isEvent(event)) throw new TypeError('Events must be plain objects with a nonempty type');
    assertJson(event, new Set());
  }
  if (commit.rewind === undefined && events.length === 0) throw new TypeError('A commit needs a rewind or events');
  return JSON.stringify({
    seq: commit.seq,
    time: commit.time,
    ...(commit.rewind === undefined ? {} : { rewind: commit.rewind }),
    ...(events.length === 0 ? {} : { events }),
  });
}

export function decodeCommit<E extends Event>(text: string, line?: number): Commit<E> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LogCorruptError('invalid JSON', line);
  }
  if (!isPlainObject(value)) throw new LogCorruptError('commit is not an object', line);
  for (const key of Object.keys(value)) {
    if (!commitFields.has(key)) throw new LogCorruptError(`unsupported commit field '${key}'`, line);
  }
  const seq = value['seq'];
  const rewind = value['rewind'];
  const events = value['events'];
  if (!isSeq(seq) || !isSeq(value['time'])) throw new LogCorruptError('invalid seq or time', line);
  if (rewind !== undefined && (!isSeq(rewind) || rewind > seq)) throw new LogCorruptError('invalid rewind', line);
  if (events !== undefined && (!Array.isArray(events) || events.length === 0 || !events.every(isEvent))) {
    throw new LogCorruptError('invalid events', line);
  }
  if (rewind === undefined && events === undefined) throw new LogCorruptError('empty commit', line);
  return deepFreeze(value) as unknown as Commit<E>;
}

export function parseLog<E extends Event>(text: string): Commit<E>[] {
  const lines = text.split('\n');
  lines.pop();
  return lines.map((line, index) => decodeCommit<E>(line, index + 1));
}
