import type { Branch } from '#/store/branch';
import type { Tree } from '#/store/tree';
import type { AppendInput, EntryLine } from '#/store/types';
import { isOffloadedPayload } from '#/store/types';

export interface JournalRecord {
  branch: string;
  seq: number;
  ts: number;
  type: string;
  kind: string;
  data: unknown;
}

export interface StoreJournal {
  readonly ref: { tree: string; branch: string };
  append(input: AppendInput): Promise<EntryLine>;
  read(): AsyncIterable<JournalRecord>;
  nextSeq(): number;
  settled(): Promise<void>;
}

export interface SyncStoreJournal extends StoreJournal {
  readSync(): JournalRecord[];
}

export function memoryJournal(ref?: { tree: string; branch: string }): SyncStoreJournal {
  const journalRef = ref ?? { tree: 'memory', branch: 'main' };
  const entries: EntryLine[] = [];
  const records = (): JournalRecord[] =>
    entries.map((entry) => ({
      branch: journalRef.branch,
      seq: entry.seq,
      ts: entry.ts,
      type: entry.type,
      kind: entry.payload.kind,
      data: isOffloadedPayload(entry.payload) ? null : entry.payload.data,
    }));
  return {
    ref: journalRef,
    append: (input) => {
      const data = input.data ?? null;
      const entry: EntryLine = {
        kind: 'entry',
        seq: entries.length,
        ts: Date.now(),
        type: input.type,
        payload: { kind: input.kind, size: JSON.stringify(data).length, data },
      };
      entries.push(entry);
      return Promise.resolve(entry);
    },
    read: async function* () {
      for (const record of records()) yield record;
    },
    readSync: records,
    nextSeq: () => entries.length,
    settled: () => Promise.resolve(),
  };
}

export function journalFromBranch(branch: Branch, tree: Tree): StoreJournal {
  return {
    ref: { tree: branch.tree, branch: branch.name },
    append: (input) => branch.append(input),
    settled: () => branch.settled(),
    read: () => readBranchChain(branch, tree),
    nextSeq: () => branch.nextSeq,
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
        data: await tree.resolve(entry),
      };
    }
  }
}
