export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface BranchHeader {
  version: 1;
  tree: string;
  branch: string;
  createdAt: number;
  parentBranch?: string;
  parentSeq?: number;
}

export type Payload =
  | { kind: string; size: number; data: unknown }
  | { kind: string; size: number; ref: string };

export function isOffloadedPayload(payload: Payload): payload is { kind: string; size: number; ref: string } {
  return 'ref' in payload;
}

export interface EntryLine {
  kind: 'entry';
  seq: number;
  ts: number;
  type: string;
  payload: Payload;
}

export type CorruptionKind =
  | 'missing'
  | 'syntax'
  | 'schema'
  | 'seq-gap'
  | 'parent-ref'
  | 'header'
  | 'blob-missing'
  | 'blob-crc';

export interface CorruptionReport {
  tree: string;
  branch: string;
  seq: number | null;
  line: number;
  kind: CorruptionKind;
  raw?: string;
  detail: string;
}

export interface BranchRef {
  branch: string;
  seq: number;
}

export interface Subscriber {
  onAppend?(tree: string, branch: string, entry: EntryLine): void;
  onCorruption?(report: CorruptionReport): void;
}

export interface SubscriberRegistration {
  prefix: string;
  subscriber: Subscriber;
}

export interface AppendInput {
  type: string;
  kind: string;
  data?: unknown;
}

export interface TreeStoreOptions {
  offloadThreshold?: number;
  fsync?: boolean;
  subscribers?: SubscriberRegistration[];
}

export const DEFAULT_OFFLOAD_THRESHOLD = 64 * 1024;
