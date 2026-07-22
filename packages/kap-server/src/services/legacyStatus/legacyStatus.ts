/**
 * `LegacyStatus` — kap-server-layer projection of the v1-style
 * combined `agent.status.updated` payload from the agent's native v2 services.
 *
 * v1 emits a single `agent.status.updated` carrying usage + contextTokens +
 * maxContextTokens + model together. v2 splits those into independent Models /
 * Ops (`usage.record`, `context_size.measured`, `config.update` …), so the
 * partial events reach clients separately and a usage-only event can overwrite
 * a previously-known contextTokens with a stale zero. The v1 edge re-reads the
 * authoritative services when a native status or context change arrives, so it
 * always forwards a real, consistent context-window value.
 *
 * Temporary bridge while the v2 wire contract still exposes the slices
 * separately — defined at the kap-server edge rather than in agent-core-v2 so
 * the core engine stays free of v1 wire-compatibility concerns.
 */

import {
  IAgentContextSizeService,
  IAgentProfileService,
  IAgentUsageService,
  IWireService,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';
import { ContextSizeModel } from '@moonshot-ai/agent-core-v2';
import type { AgentActivityState } from '@moonshot-ai/agent-core-v2';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';

/**
 * The v1 `phase` field of the combined `agent.status.updated` payload — a
 * v1-only concept with no producer on the v2 side (v2's native status events
 * never carry it), so it is defined here at the v1 edge that projects it.
 */
export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly since: number;
    }
  | {
      readonly kind: 'streaming';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly stream: 'assistant' | 'thinking' | 'tool_call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly since: number;
    }
  | {
      readonly kind: 'tool_call';
      readonly turnId: number;
      readonly step: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly since: number;
    }
  | {
      readonly kind: 'retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName?: string;
      readonly statusCode?: number;
      readonly since: number;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly turnId: number;
      readonly step?: number;
      readonly approval?: unknown;
      readonly since: number;
    }
  | {
      readonly kind: 'interrupted';
      readonly turnId: number;
      readonly step?: number;
      readonly reason: 'aborted' | 'max_steps' | 'error';
      readonly message?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'ended';
      readonly turnId: number;
      readonly reason: TurnEndReason;
      readonly durationMs?: number;
      readonly at: number;
    };

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly model: string;
}

/** Read the current combined status when the handle exposes a complete agent. */
export function readLegacyStatus(agent: IAgentScopeHandle): LegacyStatusSnapshot | undefined {
  const profile = agent.accessor.get(IAgentProfileService) as
    | IAgentProfileService
    | undefined;
  const usageService = agent.accessor.get(IAgentUsageService) as
    | IAgentUsageService
    | undefined;
  const contextSize = agent.accessor.get(IAgentContextSizeService) as
    | IAgentContextSizeService
    | undefined;
  const wire = agent.accessor.get(IWireService) as IWireService | undefined;
  if (
    profile === undefined ||
    usageService === undefined ||
    contextSize === undefined ||
    wire === undefined
  ) {
    return undefined;
  }
  const usage = usageService.status();
  // Live (measured + estimated) context size — mirrors the REST status rollup
  // (`ISessionLegacyService.status`) and v1's `context.tokenCount`, which
  // reflect the context even before the first measured exchange completes.
  // `size` alone can transiently dip below the last measured total while a
  // post-step fold/rewrite leaves the context shorter than the measured
  // prefix (the estimate then excludes the system prompt); the measured total
  // is the better reading there. Every REAL shrink (undo / clear / compaction)
  // rebases the measured model first, so the max only wins in that window.
  const measured = wire.getModel(ContextSizeModel);
  const contextTokens = Math.max(contextSize.get().size, measured.tokens);
  const capabilities = profile.getModelCapabilities();
  const maxContextTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  const model = profile.getModel();
  return { usage, contextTokens, maxContextTokens, model };
}

/**
 * Map the native v2 `AgentActivityState` to the legacy v1 `AgentPhase`
 * (`agent.status.updated` payload). Pure function — kept at the kap-server
 * edge so the core engine stays free of v1 wire-compatibility concerns.
 *
 * Returns `undefined` for `disposing` / `disposed`, which have no v1
 * concept (emitting `idle` would mislead the UI).
 *
 * Three deliberate v1 divergences from the naive mapping (see status-refactor
 * plan 04 §3): a parallel approval resolve keeps `awaiting_approval` while any
 * approval is still pending (no premature `running`); `interrupted` carries the
 * `endingReason`; `disposing`/`disposed` emit nothing.
 */
export function toLegacyPhase(state: AgentActivityState): AgentPhase | undefined {
  const { lifecycle, turn, lastTurn } = state;

  if (turn === undefined && lifecycle === 'ready') {
    if (lastTurn !== undefined && lifecycle === 'ready') {
      return {
        kind: 'ended',
        turnId: lastTurn.turnId,
        reason: lastTurn.reason,
        durationMs: lastTurn.durationMs,
        at: lastTurn.at,
      };
    }
    return { kind: 'idle' };
  }

  if (lifecycle === 'ready' && turn !== undefined) {
    if (turn.pendingApprovals.length > 0) {
      const latest = turn.pendingApprovals[turn.pendingApprovals.length - 1]!;
      return {
        kind: 'awaiting_approval',
        turnId: turn.turnId,
        step: turn.step || undefined,
        approval: { approvalId: latest.approvalId, toolCallId: latest.toolCallId },
        since: latest.since,
      };
    }
    if (turn.ending && turn.endingReason !== undefined) {
      return {
        kind: 'interrupted',
        turnId: turn.turnId,
        step: turn.step,
        reason: turn.endingReason,
        at: turn.since,
      };
    }
    switch (turn.phase) {
      case 'running':
        return {
          kind: 'running',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          since: turn.since,
        };
      case 'streaming':
        return {
          kind: 'streaming',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          stream: turn.stream ?? 'assistant',
          since: turn.since,
        };
      case 'retrying':
        return {
          kind: 'retrying',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          failedAttempt: turn.retry?.failedAttempt ?? 0,
          nextAttempt: turn.retry?.nextAttempt ?? 0,
          maxAttempts: turn.retry?.maxAttempts ?? 0,
          delayMs: turn.retry?.delayMs ?? 0,
          errorName: turn.retry?.errorName,
          statusCode: turn.retry?.statusCode,
          since: turn.since,
        };
      case 'tool_call': {
        const latest = turn.activeToolCalls[turn.activeToolCalls.length - 1];
        return {
          kind: 'tool_call',
          turnId: turn.turnId,
          step: turn.step,
          toolCallId: latest?.toolCallId ?? '',
          name: latest?.name ?? '',
          since: latest?.since ?? turn.since,
        };
      }
    }
  }

  // `disposing` / `disposed` — no v1 concept.
  return undefined;
}
