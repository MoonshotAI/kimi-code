import type { StoreBackend } from '../backend/backend';
import type { CorruptionReport, EntryLine } from '../types';

export interface TreeContext {
  backend: StoreBackend;
  offloadThreshold: number;
  fsync: boolean;
  notifyAppend(tree: string, branch: string, entry: EntryLine): void;
  notifyCorruption(report: CorruptionReport): void;
}
