import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import type { Message } from '#human/llm/message';
import { ITelemetryService } from '#/app/telemetry/telemetry';
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

export class AgentLoopProjector {
  constructor(
    private readonly log: ILogService,
    private readonly telemetry: ITelemetryService,
    private readonly states: IAgentStateService,
  ) {
    this.states.contributeState(contextProjectorLastRepairSignatureKey);
  }

  private get lastRepairSignature(): string | null {
    return this.states.get(contextProjectorLastRepairSignatureKey);
  }

  private set lastRepairSignature(value: string | null) {
    this.states.set(contextProjectorLastRepairSignatureKey, value);
  }

  project(messages: readonly ContextMessage[], strict = false): readonly Message[] {
    return this.projectWithTrace(messages, strict ? projectStrict : project);
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
