import type {
  AgentState,
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { TranscriptPage } from '../transcript/api';

export const AUDIT_TRAIL_MAX_ENTRIES = 5000;

interface AuditEntryBase {
  readonly index: number;
  readonly at: string;
  readonly state: AgentState;
  readonly summary: string;
}

export interface RestAuditEntry extends AuditEntryBase {
  readonly kind: 'rest';
  readonly request: { readonly beforeTurn?: string | undefined; readonly pageSize: number };
  readonly appliedAs: 'replace' | 'prepend';
  readonly page: TranscriptPage;
}

export interface OpsAuditEntry extends AuditEntryBase {
  readonly kind: 'ops';
  readonly envelopeAt?: string | undefined;
  readonly ops: readonly TranscriptOperation[];
  readonly delivery: 'live' | 'buffered' | 'flushed' | 'catchup';
}

export interface ResetAuditEntry extends AuditEntryBase {
  readonly kind: 'reset';
  readonly envelopeAt?: string | undefined;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly hasMoreOlder: boolean;
}

export interface EventAuditEntry extends AuditEntryBase {
  readonly kind: 'event';
  readonly event: 'ack-refresh' | 'resync' | 'gap' | 'prompt' | 'cancel';
  readonly detail?: string | undefined;
}

export type AuditEntry = RestAuditEntry | OpsAuditEntry | ResetAuditEntry | EventAuditEntry;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type AuditEntryInput = DistributiveOmit<AuditEntry, 'index' | 'at'>;

function summarizeOps(ops: readonly TranscriptOperation[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ');
}

export class AuditTrail {
  private entryList: AuditEntry[] = [];
  private nextIndex = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getEntries(): readonly AuditEntry[] {
    return this.entryList;
  }

  recordRest(
    request: RestAuditEntry['request'],
    appliedAs: RestAuditEntry['appliedAs'],
    page: TranscriptPage,
    state: AgentState,
  ): void {
    const cursor = request.beforeTurn !== undefined ? `?before_turn=${request.beforeTurn}` : '';
    this.push({
      kind: 'rest',
      request,
      appliedAs,
      page,
      state,
      summary: `GET transcript${cursor} → ${page.items.length} items (${appliedAs})`,
    });
  }

  recordOps(
    ops: readonly TranscriptOperation[],
    delivery: OpsAuditEntry['delivery'],
    envelopeAt: string | undefined,
    state: AgentState,
  ): void {
    this.push({
      kind: 'ops',
      ops,
      delivery,
      envelopeAt,
      state,
      summary: `${ops.length} ops (${summarizeOps(ops)}) [${delivery}]`,
    });
  }

  recordReset(
    snapshot: AgentTranscriptSnapshot,
    hasMoreOlder: boolean,
    envelopeAt: string | undefined,
    state: AgentState,
  ): void {
    this.push({
      kind: 'reset',
      snapshot,
      hasMoreOlder,
      envelopeAt,
      state,
      summary: `reset snapshot (${snapshot.items.length} items) — ignored by chat store`,
    });
  }

  recordEvent(
    event: EventAuditEntry['event'],
    detail: string | undefined,
    state: AgentState,
  ): void {
    const label =
      event === 'ack-refresh'
        ? 'subscribe ack → REST refresh'
        : event === 'resync'
          ? 'resync_required → REST refresh'
          : event === 'gap'
            ? 'append gap → REST refresh'
            : event === 'prompt'
              ? 'prompt sent'
              : 'cancel sent';
    this.push({
      kind: 'event',
      event,
      detail,
      state,
      summary: detail !== undefined && detail !== '' ? `${label}: ${detail}` : label,
    });
  }

  private push(entry: AuditEntryInput): void {
    const full = { ...entry, index: this.nextIndex, at: new Date().toISOString() } as AuditEntry;
    this.nextIndex += 1;
    const kept =
      this.entryList.length >= AUDIT_TRAIL_MAX_ENTRIES
        ? this.entryList.slice(this.entryList.length - AUDIT_TRAIL_MAX_ENTRIES + 1)
        : this.entryList;
    this.entryList = [...kept, full];
    for (const listener of this.listeners) listener();
  }
}
