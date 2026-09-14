import {
  INTERACTION_TAG_AGENT_ID,
  interactions,
  type AgentActivitySnapshot,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import {
  toLegacyPhase,
  type AgentPhase,
  type LegacyActivityApproval,
  type LegacyActivityLastTurn,
} from './legacyStatus';

export function legacyApprovalsOf(handle: IAgentScopeHandle): readonly LegacyActivityApproval[] {
  return interactions
    .findAll({ kind: 'approval', resolved: false, tags: { [INTERACTION_TAG_AGENT_ID]: handle.id } })
    .map((interaction) => ({
      approvalId: interaction.id,
      toolCallId: (interaction.payload as { toolCallId?: string }).toolCallId ?? '',
      since: interaction.createdAt,
    }));
}

export class LegacyActivityTracker {
  private readonly toolSince = new Map<string, number>();
  private lastTurn: LegacyActivityLastTurn | undefined;
  private lastPhaseKey: string | undefined;

  constructor(
    private readonly readSnapshot: () => AgentActivitySnapshot,
    private readonly readApprovals: () => readonly LegacyActivityApproval[],
  ) {}

  toolStarted(toolCallId: string): void {
    this.toolSince.set(toolCallId, Date.now());
  }

  toolResult(toolCallId: string): void {
    this.toolSince.delete(toolCallId);
  }

  interrupted(event: { readonly turnId: number; readonly step: number; readonly reason: string }): AgentPhase | undefined {
    if (event.reason !== 'aborted' && event.reason !== 'max_steps' && event.reason !== 'error') {
      return undefined;
    }
    return this.emit({
      kind: 'interrupted',
      turnId: event.turnId,
      step: event.step,
      reason: event.reason,
      at: Date.now(),
    });
  }

  turnEnded(event: {
    readonly turnId: number;
    readonly reason: LegacyActivityLastTurn['reason'];
    readonly durationMs?: number;
  }): AgentPhase | undefined {
    this.toolSince.clear();
    this.lastTurn = {
      turnId: event.turnId,
      reason: event.reason,
      durationMs: event.durationMs,
      at: Date.now(),
    };
    return this.emit({
      kind: 'ended',
      turnId: event.turnId,
      reason: event.reason,
      durationMs: event.durationMs,
      at: this.lastTurn.at,
    });
  }

  recompute(): AgentPhase | undefined {
    const snapshot = this.readSnapshot();
    const turn = snapshot.turn;
    return this.emit(
      toLegacyPhase({
        turn:
          turn === undefined
            ? undefined
            : {
                turnId: turn.turnId,
                phase: turn.phase,
                step: turn.step,
                ending: turn.ending,
                endingReason: turn.endingReason,
                retry: turn.retry,
                pendingApprovals: this.readApprovals(),
                activeToolCalls: turn.activeToolCalls.map((call) => ({
                  toolCallId: call.toolCallId,
                  name: call.name,
                  since: this.toolSince.get(call.toolCallId) ?? turn.since ?? Date.now(),
                })),
                since: turn.since ?? Date.now(),
              },
        lastTurn: this.lastTurn,
      }),
    );
  }

  private emit(phase: AgentPhase | undefined): AgentPhase | undefined {
    if (phase === undefined) return undefined;
    const key = JSON.stringify(phase);
    if (key === this.lastPhaseKey) return undefined;
    this.lastPhaseKey = key;
    return phase;
  }
}

export function phaseFromDomainEvent(
  tracker: LegacyActivityTracker,
  event: { readonly type: string; readonly toolCallId?: string; readonly turnId?: number; readonly step?: number; readonly reason?: string; readonly durationMs?: number },
): AgentPhase | undefined {
  switch (event.type) {
    case 'turn.started':
    case 'turn.step.started':
    case 'turn.step.retrying':
    case 'permission.approval.requested':
    case 'permission.approval.resolved':
      return tracker.recompute();
    case 'tool.call.started':
      if (event.toolCallId !== undefined) tracker.toolStarted(event.toolCallId);
      return tracker.recompute();
    case 'tool.result':
      if (event.toolCallId !== undefined) tracker.toolResult(event.toolCallId);
      return tracker.recompute();
    case 'turn.step.interrupted':
      if (event.turnId === undefined || event.step === undefined || event.reason === undefined) {
        return undefined;
      }
      return tracker.interrupted({ turnId: event.turnId, step: event.step, reason: event.reason });
    case 'turn.ended':
      if (event.turnId === undefined || event.reason === undefined) return undefined;
      return tracker.turnEnded({
        turnId: event.turnId,
        reason: event.reason as LegacyActivityLastTurn['reason'],
        durationMs: event.durationMs,
      });
    default:
      return undefined;
  }
}
