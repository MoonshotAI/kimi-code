/**
 * `record` domain (L3) — `IAgentRecordService` contract.
 *
 * Single entry point for recording facts that happen inside an agent. One
 * `append(record)` call fans out to every facet declared for the record type:
 * durable persistence (for resume), live broadcast (`AgentEvent` to the edge),
 * and the replay read model. `signal(event)` emits a live-only event that is
 * never recorded (deltas / progress). The replay read model (`buildReplay`,
 * `push`/`patchLast`/`removeLastMessages`) is owned here too — it is just one
 * more projection of the same record stream. Bound at Agent scope.
 */

import type { AgentEvent } from '@moonshot-ai/protocol';

import type { IDisposable } from '#/_base/di';
import { createDecorator } from '#/_base/di';
import type { ContextMessage } from '#/agent/contextMemory';
import type {
  IAgentWireRecordService,
  WireRecordBlobSelector,
  WireRecordMap,
  WireRecordRestoringContext,
} from '#/agent/wireRecord';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '#/agent/replayBuilder/types';

/**
 * Per-agent fact registry. Each domain augments `WireRecordMap` (in
 * `#/agent/wireRecord`) to declare the payload shape of the records it owns;
 * `AgentRecordMap` extends it so the same record types are accepted by the
 * `record` facade and by the persistence layer (`PersistedWireRecord`) without
 * duplication. New domains may augment either interface.
 */
export interface AgentRecordMap extends WireRecordMap {}

export type AgentRecord<K extends keyof AgentRecordMap = keyof AgentRecordMap> = {
  [T in K]: { readonly type: T; readonly time?: number } & Readonly<AgentRecordMap[T]>;
}[K];

/**
 * Facets declared for a record type. Every facet is optional: a record with no
 * facets is still persisted (durable) but broadcasts nothing and captures no
 * replay. Restore-time behavior (resume + replay capture) is driven entirely
 * by these facets, so business code never re-implements the live/restore split.
 */
export interface RecordFacets<K extends keyof AgentRecordMap> {
  /**
   * Live projection: `record → AgentEvent` broadcast on the wire. When omitted
   * the record is not broadcast live. Automatically suppressed while restoring.
   */
  readonly toLive?: (record: AgentRecord<K>) => AgentEvent;
  /**
   * Replay projection: `record →` zero/one/many replay records. Runs on both
   * the live `append` path and the restore path; the replay layer gates by
   * phase so live appends are only captured when `captureLiveRecords` is set.
   */
  readonly toReplay?: (
    record: AgentRecord<K>,
  ) => AgentReplayRecordPayload | readonly AgentReplayRecordPayload[] | undefined;
  /** Resumer: rebuild in-memory state from a restored record. */
  readonly resume?: (record: AgentRecord<K>) => void | Promise<void>;
  /**
   * Blob offload/rehydrate selector for large content parts (e.g. images in
   * context messages). Forwarded to the durable store so oversized parts are
   * offloaded to the blob store on append and rehydrated on restore.
   */
  readonly blobs?: WireRecordBlobSelector<AgentRecord<K>>;
}

export interface ReplayRangeOptions {
  readonly start?: number;
  readonly count?: number;
}

/**
 * Static construction options for `AgentRecordService`, supplied through a
 * `SyncDescriptor` when the service is seeded into a scope. `range` limits the
 * replay read model to a slice of the restored stream (used by partial-resume).
 */
export interface RecordServiceOptions {
  readonly range?: ReplayRangeOptions;
}

export interface IAgentRecordService {
  readonly _serviceBrand: undefined;

  /** Record a fact: persists it and fans out to its declared facets. */
  append(record: AgentRecord): void;
  /**
   * Subscribe to the live `AgentEvent` stream. Suppressed while restoring so
   * edge consumers never receive historical events. This is the contract the
   * `server-v2` edge depends on (`on(handler)` → `AgentEvent`).
   */
  on(handler: (event: AgentEvent) => void): IDisposable;
  /** Emit a live-only event that is never persisted (deltas / progress). */
  signal(event: AgentEvent): void;
  /**
   * Declare the facets for a record type. Call from a domain's constructor.
   * Returns a disposable that unregisters the facets (and the resumer).
   */
  define<K extends keyof AgentRecordMap>(type: K, facets: RecordFacets<K>): IDisposable;
  /**
   * Append a record to the replay read model directly. Used when the projected
   * data is computed inside a domain handler rather than derived from a single
   * record via `toReplay` (e.g. `contextMemory` projecting spliced messages).
   * Gated by phase: captured while restoring/post-restoring, or always when
   * `captureLiveRecords` is set.
   */
  push(record: AgentReplayRecordPayload): void;
  /** Patch the most recent replay record of `type` (restore-time only). */
  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void;
  /** Drop replay `message` records whose message is in `removedMessages`. */
  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void;
  /** Replay read model built from restored (and optionally live) records. */
  buildReplay(): readonly AgentReplayRecord[];
  /** When true, live `append` calls also feed the replay read model. */
  captureLiveRecords: boolean;
  readonly restoring: WireRecordRestoringContext | null;
  readonly postRestoring: boolean;

  readonly hooks: IAgentWireRecordService['hooks'];
}

export const IAgentRecordService = createDecorator<IAgentRecordService>('agentRecordService');
