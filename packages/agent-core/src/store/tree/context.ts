import type { TreeBackend } from './backend/backend';
import type { CorruptionReport, EntryLine } from './types';

export interface TreeContext {
  backend: TreeBackend;
  fsync: boolean;
  notifyAppend(tree: string, branch: string, entry: EntryLine): void;
  notifyCorruption(report: CorruptionReport): void;
}
