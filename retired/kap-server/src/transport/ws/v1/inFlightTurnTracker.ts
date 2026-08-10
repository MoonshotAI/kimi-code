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
 *
 * Engine mode: the applied frames are the projected Rust wire events — the v2
 * `Event` union was retired with the engine migration, so the frame shape is
 * the narrow `RustEventFrame` here.
 */

import type { InFlightToolCall, InFlightTurn } from '../../../protocol/rest-snapshot';

const MAIN_AGENT_ID = 'main';

/** A projected Rust wire event frame (fields narrowed by assertion). */
type RustEventFrame = {
  readonly type: string;
  readonly agentId?: string;
  [key: string]: unknown;
};

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

  apply(sessionId: string, event: RustEventFrame): VolatileAnnotation {
    if (event.agentId !== undefined && event.agentId !== MAIN_AGENT_ID) return {};

    switch (event.type) {
      case 'turn.started': {
        this.bySession.set(sessionId, {
          turnId: event['turnId'] as number,
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
        if (!turn || turn.turnId !== (event['turnId'] as number)) return {};
        turn.assistantText = '';
        turn.thinkingText = '';
        return {};
      }
      case 'assistant.delta': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== (event['turnId'] as number)) return {};
        const delta = event['delta'] as string;
        const offset = turn.assistantText.length;
        turn.assistantText += delta;
        return { offset };
      }
      case 'thinking.delta': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== (event['turnId'] as number)) return {};
        const delta = event['delta'] as string;
        const offset = turn.thinkingText.length;
        turn.thinkingText += delta;
        return { offset };
      }
      case 'tool.call.started': {
        const turn = this.bySession.get(sessionId);
        if (!turn || turn.turnId !== (event['turnId'] as number)) return {};
        const toolCallId = event['toolCallId'] as string;
        turn.tools.set(toolCallId, {
          tool_call_id: toolCallId,
          name: event['name'] as string,
          args: event['args'],
          ...(event['description'] !== undefined ? { description: event['description'] as string } : {}),
          ...(event['display'] !== undefined ? { display: event['display'] } : {}),
        });
        return {};
      }
      case 'tool.progress': {
        const turn = this.bySession.get(sessionId);
        const tool = turn?.tools.get(event['toolCallId'] as string);
        if (!tool) return {};
        const update = event['update'] as { kind: string; text?: string; percent?: number };
        const { kind, text, percent } = update;
        if (kind === 'custom') return {};
        tool.last_progress = {
          kind: kind as 'stdout' | 'stderr' | 'progress' | 'status' | 'custom',
          ...(text !== undefined ? { text } : {}),
          ...(percent !== undefined ? { percent } : {}),
        };
        return {};
      }
      case 'tool.result': {
        this.bySession.get(sessionId)?.tools.delete(event['toolCallId'] as string);
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
