/**
 * session-event-translate.ts — engine `host/event` → SDK `Event` bridge.
 *
 * The session-owned engine reports lifecycle, streaming, and tool activity
 * as flat wire events (`session.*`, `llm.*`). The TUI's renderer consumes
 * the SDK's `Event` union (`turn.started`, `assistant.delta`,
 * `tool.call.started`, …). This translator maps the former onto the latter
 * so `SessionEventHandler.handleEvent` can drive the existing transcript
 * pipeline unchanged when the engine owns the loop.
 *
 * Stateful on purpose: streaming deltas carry no turn id on the wire, so the
 * translator remembers the turn opened by `session.turn.started`.
 */
import type { Event } from '@moonshot-ai/kimi-code-sdk';

interface EngineWireEvent {
  type?: string;
  session_id?: string | null;
  turn_id?: number;
  stop_reason?: string;
  steps?: number;
  status?: string;
  part?: { type?: string; text?: string; think?: string };
  tool_call_id?: string;
  tool_name?: string;
  arguments?: unknown;
  content?: string;
  is_error?: boolean;
}

export class SessionEventTranslator {
  private currentTurnId = 0;

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
  ) {}

  /**
   * Translate one engine event; null means "nothing to render" (unknown or
   * purely internal event types pass through silently).
   */
  translate(raw: unknown): Event | null {
    const event = raw as EngineWireEvent;
    const base = { sessionId: this.sessionId, agentId: this.agentId };
    switch (event.type) {
      case 'session.turn.started': {
        this.currentTurnId = event.turn_id ?? this.currentTurnId + 1;
        return {
          ...base,
          type: 'turn.started',
          turnId: this.currentTurnId,
          origin: { kind: 'user' },
        };
      }
      case 'session.turn.ended': {
        const turnId = event.turn_id ?? this.currentTurnId;
        return {
          ...base,
          type: 'turn.ended',
          turnId,
          reason: mapStopReason(event.stop_reason),
        };
      }
      case 'llm.delta': {
        if (event.part?.type === 'text' && event.part.text !== undefined) {
          return {
            ...base,
            type: 'assistant.delta',
            turnId: this.currentTurnId,
            delta: event.part.text,
          };
        }
        if (event.part?.type === 'think' && event.part.think !== undefined) {
          return {
            ...base,
            type: 'thinking.delta',
            turnId: this.currentTurnId,
            delta: event.part.think,
          };
        }
        return null;
      }
      case 'session.tool.started': {
        return {
          ...base,
          type: 'tool.call.started',
          turnId: this.currentTurnId,
          toolCallId: event.tool_call_id ?? '',
          name: event.tool_name ?? '',
          args: event.arguments,
        };
      }
      case 'session.tool.settled': {
        return {
          ...base,
          type: 'tool.result',
          turnId: this.currentTurnId,
          toolCallId: event.tool_call_id ?? '',
          output: event.content ?? '',
          isError: event.is_error === true,
        };
      }
      // session.goal.updated carries only a status string; the SDK
      // `goal.updated` event wants a full snapshot. Skipped until the
      // engine reports the snapshot shape.
      default:
        return null;
    }
  }
}

function mapStopReason(stopReason: string | undefined): 'completed' | 'cancelled' | 'failed' {
  switch (stopReason) {
    case 'Aborted':
      return 'cancelled';
    case 'Failed':
      return 'failed';
    default:
      return 'completed';
  }
}
