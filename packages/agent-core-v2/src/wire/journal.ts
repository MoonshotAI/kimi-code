import type { RecordDehydrator, WireRecord } from './record';

export interface AgentJournalRef {
  readonly tree: string;
  readonly branch: string;
}

export interface SwitchBranchInput {
  readonly turns: number;
  readonly reason?: string;
  readonly fromTurnId?: number;
}

export interface SwitchedBranch {
  readonly branch: string;
  readonly base: { readonly branch: string; readonly line: number };
  readonly edgeLine: number;
  readonly forkLine: number;
}

export interface IAgentJournal {
  readonly journalRef: AgentJournalRef;
  append(record: WireRecord, dehydrate?: RecordDehydrator): void;
  read(): AsyncIterable<WireRecord>;
  readRaw(): AsyncIterable<WireRecord>;
  switchBranch(input: SwitchBranchInput): Promise<SwitchedBranch>;
  branches(): readonly string[];
  nextSeq(): number;
  settled(): Promise<void>;
}
