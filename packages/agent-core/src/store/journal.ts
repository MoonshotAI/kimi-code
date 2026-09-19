import type { Entry, Journal } from './store';
import type { AppendInput, Branch, BranchRef, EntryLine, Tree } from './tree';

interface JournalRecord {
  branch: string;
  seq: number;
  ts: number;
  type: string;
  kind: string;
  data: unknown;
}

interface BranchJournalSource {
  append(input: AppendInput): Promise<EntryLine>;
  read(): AsyncIterable<JournalRecord>;
  settled(): Promise<void>;
}

function journalFromBranch(branch: Branch, tree: Tree): BranchJournalSource {
  return {
    append: (input) => branch.append(input),
    settled: () => branch.settled(),
    read: () => readBranchChain(branch, tree),
  };
}

async function* readBranchChain(branch: Branch, tree: Tree): AsyncIterable<JournalRecord> {
  const chain: { name: string; entries: EntryLine[] }[] = [];
  let current: Branch | undefined = branch;
  let upto: number | null = null;
  while (current !== undefined) {
    const head = upto ?? current.head;
    const entries: EntryLine[] = [];
    for (let seq = 0; seq <= (head ?? -1); seq++) {
      const entry = current.entryAt(seq);
      if (entry !== null) entries.push(entry);
    }
    chain.push({ name: current.name, entries });
    const parentBranch: string | undefined = current.header.parentBranch;
    const parentSeq: number | undefined = current.header.parentSeq;
    current =
      parentBranch !== undefined && parentSeq !== undefined && tree.has(parentBranch)
        ? tree.openBranch(parentBranch)
        : undefined;
    upto = parentSeq ?? null;
  }
  for (const segment of chain.reverse()) {
    for (const entry of segment.entries) {
      yield {
        branch: segment.name,
        seq: entry.seq,
        ts: entry.ts,
        type: entry.type,
        kind: entry.payload.kind,
        data: entry.payload.data,
      };
    }
  }
}

export interface RecordEvent {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

const payloadKind = 'event';

class Operations {
  private tail: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private closing: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error('Journal is closed'));
    const result = this.tail.then(() => {
      if (this.failure !== undefined) throw this.failure.error;
      return operation();
    });
    this.tail = result.then(
      () => undefined,
      (error: unknown) => { this.failure ??= { error }; },
    );
    return result;
  }

  close(cleanup: () => Promise<void>): Promise<void> {
    this.closing ??= this.tail.then(async () => {
      const errors: unknown[] = this.failure === undefined ? [] : [this.failure.error];
      try {
        await cleanup();
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Journal close failed');
    });
    return this.closing;
  }
}

function isRecord(value: unknown): value is RecordEvent {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function assertRecord(value: unknown): asserts value is RecordEvent {
  if (!isRecord(value) || value.type.length === 0) throw new Error('Expected a record with a nonempty type');
  if (value.time !== undefined && (typeof value.time !== 'number' || !Number.isFinite(value.time))) {
    throw new Error('Record time must be a finite number');
  }
}

function inspectJson(value: unknown, freeze: boolean, ancestors = new Set<object>()): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new Error('Records must contain acyclic JSON values');
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Records must contain only plain objects and arrays');
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) inspectJson(item, freeze, ancestors);
  ancestors.delete(value);
  if (freeze) Object.freeze(value);
}

function snapshot(value: unknown): RecordEvent {
  assertRecord(value);
  inspectJson(value, false);
  const record: unknown = JSON.parse(JSON.stringify(value));
  assertRecord(record);
  inspectJson(record, true);
  return record;
}

export interface BranchJournal extends Journal<RecordEvent, BranchRef> {
  readonly branch: string;
  create(branchName: string, from?: BranchRef): Promise<void>;
  checkout(branchName: string): Promise<void>;
  settled(): Promise<void>;
}

export function treeJournal(tree: Tree, branch: Branch): BranchJournal {
  const operations = new Operations();
  let current = branch;
  let journal = journalFromBranch(current, tree);
  return {
    get branch() { return current.name; },
    read: () => operations.run(async () => {
      const entries: Entry<RecordEvent, BranchRef>[] = [];
      for await (const record of journal.read()) {
        const event = snapshot(record.data);
        if (record.kind !== payloadKind || record.type !== event.type) throw new Error('Unexpected native tree journal record');
        entries.push(Object.freeze({ event, cursor: { branch: record.branch, seq: record.seq } }));
      }
      return entries;
    }),
    append: (event) => {
      const record = snapshot(event);
      return operations.run(async () => {
        const entry = await journal.append({ type: record.type, kind: payloadKind, data: record });
        return Object.freeze({ event: record, cursor: { branch: current.name, seq: entry.seq } });
      });
    },
    create: (branchName, from) => operations.run(async () => {
      current = tree.createBranch(
        branchName,
        from !== undefined ? { from } : undefined,
      );
      await current.settled();
      journal = journalFromBranch(current, tree);
    }),
    checkout: (branchName) => operations.run(async () => {
      current = tree.openBranch(branchName);
      journal = journalFromBranch(current, tree);
    }),
    settled: () => operations.run(() => current.settled()),
    close: () => operations.close(() => current.settled()),
  };
}

export function decodeRecord<E extends { type: string }>(
  record: RecordEvent,
  types: ReadonlySet<E['type'] | string>,
): E | undefined {
  if (!types.has(record.type)) return undefined;
  if (record.time !== undefined && !Number.isFinite(record.time)) {
    throw new TypeError(`Invalid event time for '${record.type}'`);
  }
  return { ...record, time: record.time ?? 0 } as unknown as E;
}
