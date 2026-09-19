import type { StorageBackend } from './backend/backend';
import type { CorruptionReport, EntryLine } from './types';

export interface TreeContext {
  backend: StorageBackend;
  offloadThreshold: number;
  fsync: boolean;
  notifyAppend(tree: string, branch: string, entry: EntryLine): void;
  notifyCorruption(report: CorruptionReport): void;
}
