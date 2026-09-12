import { HUMAN_AGENT_DOMAIN, humanEventType, humanRecordType } from '#/wire/human';
import type { WireLine } from '#/wire/tree/index';
import type { IWireService } from '#/wire/wire';
import type { JournalRecord, SyncStoreJournal } from '#human/eventStore/journal';
import type { AppendInput, EntryLine } from '#human/store/types';

export const ENGINE_JOURNAL_DOMAIN = HUMAN_AGENT_DOMAIN;

function toJournalRecord(line: WireLine, domain: string, branch: string, seq: number): JournalRecord | undefined {
  const type = humanEventType(line.record.type, domain);
  if (type === undefined) return undefined;
  const ts = typeof line.record.time === 'number' ? line.record.time : 0;
  const kind = typeof line.record['kind'] === 'string' ? line.record['kind'] : 'event';
  return { branch, seq, ts, type, kind, data: { ...line.record, type } };
}

function toEntryLine(input: AppendInput, seq: number): EntryLine {
  const data = input.data ?? null;
  return {
    kind: 'entry',
    seq,
    ts: Date.now(),
    type: input.type,
    payload: { kind: input.kind, size: JSON.stringify(data).length, data },
  };
}

export function wireStoreJournal(wire: IWireService, domain: string): SyncStoreJournal {
  let records: JournalRecord[] | undefined;
  const read = (): JournalRecord[] => {
    if (records === undefined) {
      records = [];
      const branch = wire.journalRef.branch;
      for (const line of wire.readHumanChain()) {
        const record = toJournalRecord(line, domain, branch, records.length);
        if (record !== undefined) records.push(record);
      }
    }
    return records;
  };
  return {
    get ref() {
      return { tree: wire.journalRef.tree, branch: wire.journalRef.branch };
    },
    append: (input) => {
      wire.append({ ...(input.data as Record<string, unknown>), type: humanRecordType(domain, input.type), kind: input.kind });
      const journalRecord: JournalRecord = {
        branch: wire.journalRef.branch,
        seq: read().length,
        ts: Date.now(),
        type: input.type,
        kind: input.kind,
        data: input.data ?? null,
      };
      read().push(journalRecord);
      return Promise.resolve(toEntryLine(input, journalRecord.seq));
    },
    read: async function* () {
      for (const record of read()) yield record;
    },
    readSync: () => [...read()],
    nextSeq: () => read().length,
    settled: () => wire.settled(),
  };
}

export function seededStoreJournal(
  base: SyncStoreJournal,
  seed: readonly JournalRecord[],
): SyncStoreJournal {
  let appended = 0;
  return {
    get ref() {
      return base.ref;
    },
    append: async (input) => {
      const entry = await base.append(input);
      appended += 1;
      return entry;
    },
    read: async function* () {
      for (const record of seed) yield record;
    },
    readSync: () => [...seed],
    nextSeq: () => seed.length + appended,
    settled: () => base.settled(),
  };
}
