/**
 * `record` domain (L3) — `IAgentRecordService` implementation.
 *
 * Owns the unified `append` / `signal` / `define` API: one `append(record)`
 * fans out to durable persistence (delegated to `wireRecord`), live broadcast
 * (an owned `Emitter<AgentEvent>`), and replay capture (delegated to
 * `replayBuilder`). `signal(event)` emits a live-only event that is never
 * recorded. Live emission is suppressed while restoring, so edge consumers
 * never receive historical events. The former `eventSink` service is folded
 * into this class; `wireRecord` / `replayBuilder` remain registered backends
 * that this service coordinates.
 */

import { Disposable, toDisposable } from '#/_base/di';
import type { IDisposable } from '#/_base/di';
import { Emitter } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { AgentEvent } from '@moonshot-ai/protocol';

import {
  IAgentWireRecordService,
  type WireRecord,
  type WireRecordBlobSelector,
  type WireRecordMap,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
  type PersistedWireRecord,
  type WireRecordRestoringContext,
} from '#/agent/wireRecord';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import type { AgentReplayRecord } from '#/agent/replayBuilder/types';

import {
  IAgentRecordService,
  type AgentRecord,
  type AgentRecordMap,
  type RecordFacets,
} from './record';

export class AgentRecordService extends Disposable implements IAgentRecordService {
  declare readonly _serviceBrand: undefined;
  private readonly facets = new Map<keyof AgentRecordMap, RecordFacets<keyof AgentRecordMap>>();
  private readonly liveEmitter = this._register(new Emitter<AgentEvent>());

  constructor(
    @IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService,
    @IAgentReplayBuilderService private readonly replayBuilder: IAgentReplayBuilderService,
  ) {
    super();
    // Restore-time replay capture: every restored record runs its `toReplay`
    // facet. `replayBuilder.push` gates by phase, so this only records while
    // restoring / post-restoring.
    this._register(
      wireRecord.hooks.onRestoredRecord.register('record-replay', async (ctx, next) => {
        await next();
        this.runReplayFacet(ctx.record as unknown as AgentRecord);
      }),
    );
  }

  append(record: AgentRecord): void {
    this.wireRecord.append(record as unknown as WireRecord);
    const facet = this.facets.get(record.type);
    if (facet?.toLive !== undefined) {
      this.emitLive(facet.toLive(record));
    }
    if (facet?.toReplay !== undefined) {
      this.runReplayFacet(record);
    }
  }

  on(handler: (event: AgentEvent) => void): IDisposable {
    return this.liveEmitter.event(handler);
  }

  signal(event: AgentEvent): void {
    this.emitLive(event);
  }

  define<K extends keyof AgentRecordMap>(type: K, facets: RecordFacets<K>): IDisposable {
    // Merge live/replay facets rather than overwriting: the record type's owner
    // supplies `toLive`/`toReplay`, while secondary resumers (other domains that
    // listen to the same type, e.g. microCompaction listening to
    // `full_compaction.complete`) only contribute a `resume`. First writer wins
    // for live/replay; every `resume` is kept (the durable store supports
    // multiple resumers per type).
    const previous = this.facets.get(type);
    this.facets.set(type, {
      toLive: facets.toLive ?? previous?.toLive,
      toReplay: facets.toReplay ?? previous?.toReplay,
    } as RecordFacets<keyof AgentRecordMap>);
    const resumeReg =
      facets.resume === undefined
        ? undefined
        : this.wireRecord.register(
            type as unknown as keyof WireRecordMap,
            (record) => facets.resume!(record as unknown as AgentRecord<K>),
            facets.blobs === undefined
              ? undefined
              : {
                  blobs: facets.blobs as unknown as WireRecordBlobSelector<
                    WireRecord<keyof WireRecordMap>
                  >,
                },
          );
    return toDisposable(() => {
      resumeReg?.dispose();
    });
  }

  restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult> {
    return this.wireRecord.restore(records, options);
  }

  flush(): Promise<void> {
    return this.wireRecord.flush();
  }

  close(): Promise<void> {
    return this.wireRecord.close();
  }

  buildReplay(): readonly AgentReplayRecord[] {
    return this.replayBuilder.buildResult();
  }

  get captureLiveRecords(): boolean {
    return this.replayBuilder.captureLiveRecords;
  }

  set captureLiveRecords(value: boolean) {
    this.replayBuilder.captureLiveRecords = value;
  }

  get restoring(): WireRecordRestoringContext | null {
    return this.wireRecord.restoring;
  }

  get postRestoring(): boolean {
    return this.replayBuilder.postRestoring;
  }

  get hooks(): IAgentWireRecordService['hooks'] {
    return this.wireRecord.hooks;
  }

  private emitLive(event: AgentEvent): void {
    // Suppress live emission while restoring so edge consumers never receive
    // historical events (matches the former `eventSink.emit` guard).
    if (this.wireRecord.restoring !== null) return;
    this.liveEmitter.fire(event);
  }

  private runReplayFacet(record: AgentRecord): void {
    const facet = this.facets.get(record.type);
    if (facet?.toReplay === undefined) return;
    const out = facet.toReplay(record);
    if (out === undefined) return;
    const list = Array.isArray(out) ? out : [out];
    for (const replayRecord of list) {
      this.replayBuilder.push(replayRecord);
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRecordService,
  AgentRecordService,
  InstantiationType.Delayed,
  'record',
);
