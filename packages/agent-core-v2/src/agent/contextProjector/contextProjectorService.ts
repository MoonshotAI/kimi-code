import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import type { Message } from '#/kosong/contract/message';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from './contextProjector';
import {
  MEDIA_DEGRADE_KEEP_RECENT,
  captureMediaStripSnapshot,
  degradeOlderMediaParts,
  stripMediaPartsBySnapshot,
} from './mediaProjection';
import {
  project,
  projectStrict,
  summarizeProjectionRepairs,
  type OnAnomaly,
  type ProjectionAnomaly,
} from './projection';

export const contextProjectorLastRepairSignatureKey = defineState<string | null>(
  'contextProjector.lastRepairSignature',
  () => null,
);

export class AgentContextProjectorService implements IAgentContextProjectorService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    this.states.contributeState(contextProjectorLastRepairSignatureKey);
  }

  private get lastRepairSignature(): string | null {
    return this.states.get(contextProjectorLastRepairSignatureKey);
  }

  private set lastRepairSignature(value: string | null) {
    this.states.set(contextProjectorLastRepairSignatureKey, value);
  }

  project(
    messages: readonly ContextMessage[],
    policy: ProjectionPolicy = {},
  ): readonly Message[] {
    const projected = this.projectWithTrace(
      messages,
      policy.structure === 'strict' ? projectStrict : project,
    );
    const media = policy.media;
    if (media === undefined) return projected;
    if (media === 'degraded') return degradeOlderMediaParts(projected, MEDIA_DEGRADE_KEEP_RECENT);
    return stripMediaPartsBySnapshot(projected, media.strip);
  }

  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot {
    return captureMediaStripSnapshot(this.projectWithTrace(messages, project));
  }

  private projectWithTrace(
    messages: readonly ContextMessage[],
    fn: (history: readonly ContextMessage[], onAnomaly?: OnAnomaly) => Message[],
  ): readonly Message[] {
    const anomalies: ProjectionAnomaly[] = [];
    const result = fn(messages, (anomaly) => anomalies.push(anomaly));
    this.reportProjectionRepairs(anomalies);
    return result;
  }

  private reportProjectionRepairs(anomalies: readonly ProjectionAnomaly[]): void {
    const notable = anomalies.filter(
      (anomaly) => !(anomaly.kind === 'tool_result_synthesized' && anomaly.trailing),
    );
    if (notable.length === 0) {
      this.lastRepairSignature = null;
      return;
    }
    const signature = notable
      .map((anomaly) => ('toolCallId' in anomaly ? `${anomaly.kind}:${anomaly.toolCallId}` : anomaly.kind))
      .toSorted()
      .join('|');
    if (signature === this.lastRepairSignature) return;
    this.lastRepairSignature = signature;

    const {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      vacuousDropped,
    } = summarizeProjectionRepairs(notable);
    const toolCallIds = [
      ...new Set(
        notable.flatMap((anomaly) => ('toolCallId' in anomaly ? [anomaly.toolCallId] : [])),
      ),
    ].slice(0, 5);
    this.log.warn('repaired the request to keep it wire-valid', {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      vacuousDropped,
      toolCallIds,
    });
    this.telemetry.track2('context_projection_repaired', {
      reordered,
      synthesized,
      dropped_orphan: droppedOrphan,
      duplicate_calls_dropped: duplicateCallsDropped,
      duplicate_results_dropped: duplicateResultsDropped,
      leading_dropped: leadingDropped,
      assistants_merged: assistantsMerged,
      whitespace_dropped: whitespaceDropped,
      vacuous_dropped: vacuousDropped,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextProjectorService,
  AgentContextProjectorService,
  ScopeActivation.OnScopeCreated,
  'contextProjector',
);
