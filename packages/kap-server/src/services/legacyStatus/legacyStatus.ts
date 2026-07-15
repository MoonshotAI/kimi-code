/**
 * `LegacyStatus` — kap-server-layer derived model that re-derives the v1-style
 * combined `agent.status.updated` payload from the agent's native v2 services.
 *
 * v1 emits a single `agent.status.updated` carrying usage + contextTokens +
 * maxContextTokens + model together. v2 splits those into independent Models /
 * Ops (`usage.record`, `context_size.measured`, `config.update` …), so the
 * partial events reach clients separately and a usage-only event can overwrite
 * a previously-known contextTokens with a stale zero. This derived model
 * watches the status-affecting Ops and, on each, re-reads the authoritative
 * services and emits a fresh combined event so the edge always has a real,
 * consistent context-window value to forward.
 *
 * Temporary bridge while the v2 wire contract still exposes the slices
 * separately — defined at the kap-server edge rather than in agent-core-v2 so
 * the core engine stays free of v1 wire-compatibility concerns.
 */

import {
  IAgentContextSizeService,
  IAgentProfileService,
  IAgentUsageService,
  IAgentWireService,
  defineDerivedModel,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';
import { ContextSizeModel } from '@moonshot-ai/agent-core-v2';
import type {
  AgentActivitySnapshot,
  AgentPhase,
} from '@moonshot-ai/agent-core-v2';

interface LegacyStatusState {
  /** Monotonic change counter — only used to fan change notifications out. */
  readonly version: number;
}

/**
 * Reacts to the Ops that can change the status line. The state itself carries
 * no business data; the handler re-reads the authoritative services on every
 * bump so the emitted snapshot is always consistent with the live Models.
 *
 * The context-append Ops are watched alongside the usage / measurement Ops
 * because the emitted contextTokens is the live (measured + estimated) size:
 * a freshly appended prompt or step event grows it before any LLM response
 * lands. The derived model's dedupe (in the broadcaster) suppresses appends
 * that don't move the size, so the extra watches cost no extra frames.
 */
export const LegacyStatusModel = defineDerivedModel<LegacyStatusState>(
  'legacyStatus',
  () => ({ version: 0 }),
  {
    'usage.record': (s) => ({ version: s.version + 1 }),
    'context_size.measured': (s) => ({ version: s.version + 1 }),
    'context.append_message': (s) => ({ version: s.version + 1 }),
    'context.append_loop_event': (s) => ({ version: s.version + 1 }),
    'config.update': (s) => ({ version: s.version + 1 }),
  },
);

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly model: string;
}

/** Read the current combined status from the agent's authoritative services. */
export function readLegacyStatus(agent: IAgentScopeHandle): LegacyStatusSnapshot {
  const profile = agent.accessor.get(IAgentProfileService);
  const usage = agent.accessor.get(IAgentUsageService).status();
  // Live (measured + estimated) context size — mirrors the REST status rollup
  // (`ISessionLegacyService.status`) and v1's `context.tokenCount`, which
  // reflect the context even before the first measured exchange completes.
  // `size` alone can transiently dip below the last measured total while a
  // post-step fold/rewrite leaves the context shorter than the measured
  // prefix (the estimate then excludes the system prompt); the measured total
  // is the better reading there. Every REAL shrink (undo / clear / compaction)
  // rebases the measured model first, so the max only wins in that window.
  const contextSize = agent.accessor.get(IAgentContextSizeService);
  const measured = agent.accessor.get(IAgentWireService).getModel(ContextSizeModel);
  const contextTokens = Math.max(contextSize.get().size, measured.tokens);
  const maxContextTokens = profile.getModelCapabilities().max_context_tokens;
  const model = profile.getModel();
  return { usage, contextTokens, maxContextTokens, model };
}

/**
 * Map the native v2 `AgentActivitySnapshot` to the legacy v1 `AgentPhase`
 * (`agent.status.updated` payload). Pure function — kept at the kap-server
 * edge so the core engine stays free of v1 wire-compatibility concerns.
 *
 * Returns `undefined` for `disposing` / `disposed` lanes, which have no v1
 * concept (emitting `idle` would mislead the UI).
 *
 * Three deliberate v1 divergences from the naive mapping (see status-refactor
 * plan 04 §3): a parallel approval resolve keeps `awaiting_approval` while any
 * approval is still pending (no premature `running`); `interrupted` carries the
 * `endingReason`; `disposing`/`disposed` emit nothing.
 */
export function toLegacyPhase(snapshot: AgentActivitySnapshot): AgentPhase | undefined {
  const { lane, turn, lastTurn } = snapshot;

  if (lane === 'idle' || lane === 'initializing') {
    if (lastTurn !== undefined && lane === 'idle') {
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

  if (lane === 'turn' && turn !== undefined) {
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
