/**
 * `InFlightTurnTracker` — accumulates the current turn's volatile stream state
 * per session so a reconnecting client can rebuild mid-turn UI from the session
 * snapshot instead of replaying deltas (which are not journaled).
 *
 * Ported from v1 (`packages/server/src/services/gateway/inFlightTurnTracker.ts`).
 * Owned by the `SessionEventBroadcaster` and updated inside its per-session
 * dispatch queue — keeping accumulated text, the journal watermark, and fan-out
 * order mutually consistent.
 *
 * Text accumulation is step-relative: `assistantText` / `thinkingText` reset at
 * every `turn.step.started` because completed steps already live in the snapshot
 * transcript; running tools are kept (a call without `tool.result` still needs
 * seeding). The stamped delta `offset` is thus the pre-append offset within the
 * current step, and clients reset their alignment counters at step boundaries.
 *
 * Only main-agent activity is tracked: subagent deltas share the session id but
 * describe a different stream and would corrupt the accumulation.
 */

import type { Event, InFlightToolCall, InFlightTurn } from '@moonshot-ai/protocol';

const MAIN_AGENT_ID = 'main';

interface ToolAccum {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

interface TurnAccum {
  turnId: number;
  assistantText: string;
  thinkingText: string;
  tools: Map<string, ToolAccum>;
}

export interface VolatileAnnotation {
  /** Pre-append offset for text-delta frames. */
  offset?: number;
}

export class InFlightTurnTracker {
  private readonly bySession = new Map<string, TurnAccum>();

  apply(sessionId: string, event: Event): VolatileAnnotation {
    if (event.agentId !== MAIN_AGENT_ID) return {};

    switch (event.type) {
      case 'turn.started': {
        this.bySession.set(sessionId, {
          turnId: event.turnId,
          assistantText: '',
          thinkingText: '',
          tools: new Map(),
        });
        return {};
      }
      case 'turn.ended': {
        this.bySession.delete(sessionId);
        return {};
      }
      case 'turn.step.started': {
        // Prior steps' text is already in the transcript; keep running tools.
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== event.turnId) return {};
        turn.assistantText = '';
        turn.thinkingText = '';
        return {};
      }
      case 'assistant.delta': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== event.turnId) return {};
        const offset = turn.assistantText.length;
        turn.assistantText += event.delta;
        return { offset };
      }
      case 'thinking.delta': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== event.turnId) return {};
        const offset = turn.thinkingText.length;
        turn.thinkingText += event.delta;
        return { offset };
      }
      case 'tool.call.started': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== event.turnId) return {};
        turn.tools.set(event.toolCallId, {
          tool_call_id: event.toolCallId,
          name: event.name,
          args: event.args,
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.display !== undefined ? { display: event.display } : {}),
        });
        return {};
      }
      case 'tool.progress': {
        const turn = this.bySession.get(sessionId);
        const tool = turn?.tools.get(event.toolCallId);
        if (!tool) return {};
        const { kind, text, percent } = event.update;
        if (kind === 'custom') return {};
        tool.last_progress = {
          kind,
          ...(text !== undefined ? { text } : {}),
          ...(percent !== undefined ? { percent } : {}),
        };
        return {};
      }
      case 'tool.result': {
        this.bySession.get(sessionId)?.tools.delete(event.toolCallId);
        return {};
      }
      default:
        return {};
    }
  }

  get(sessionId: string): InFlightTurn | null {
    const turn = this.bySession.get(sessionId);
    if (!turn) return null;
    const running_tools: InFlightToolCall[] = Array.from(turn.tools.values()).map((t) => ({
      tool_call_id: t.tool_call_id,
      name: t.name,
      ...(t.args !== undefined ? { args: t.args } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.display !== undefined ? { display: t.display } : {}),
      ...(t.last_progress !== undefined ? { last_progress: t.last_progress } : {}),
    }));
    return {
      turn_id: turn.turnId,
      assistant_text: turn.assistantText,
      thinking_text: turn.thinkingText,
      running_tools,
    };
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
