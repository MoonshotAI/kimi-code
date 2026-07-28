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
import type { Event, GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk';

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
  snapshot?: unknown;
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
      case 'session.goal.updated': {
        // Map the engine snapshot (snake_case fields, PascalCase status)
        // onto the SDK shape. `snapshot` is null when the goal record was
        // cleared (e.g. after a completion).
        return {
          ...base,
          type: 'goal.updated',
          snapshot: mapGoalSnapshot(event.snapshot),
        };
      }
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

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function strOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function mapGoalStatus(raw: unknown): GoalStatus {
  switch (raw) {
    case 'Paused':
      return 'paused';
    case 'Blocked':
      return 'blocked';
    case 'Complete':
      return 'complete';
    case 'BudgetLimited':
      return 'budget_limited';
    case 'UsageLimited':
      return 'usage_limited';
    default:
      return 'active';
  }
}

function mapGoalSnapshot(raw: unknown): GoalSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const budget = (typeof s['budget'] === 'object' && s['budget'] !== null
    ? s['budget']
    : {}) as Record<string, unknown>;
  return {
    goalId: strOr(s['goal_id']),
    objective: strOr(s['objective']),
    completionCriterion:
      typeof s['completion_criterion'] === 'string' ? s['completion_criterion'] : undefined,
    status: mapGoalStatus(s['status']),
    turnsUsed: Number(s['turns_used'] ?? 0),
    tokensUsed: Number(s['tokens_used'] ?? 0),
    wallClockMs: Number(s['wall_clock_ms'] ?? 0),
    budget: {
      tokenBudget: numOrNull(budget['token_budget']),
      turnBudget: numOrNull(budget['turn_budget']),
      wallClockBudgetMs: numOrNull(budget['wall_clock_budget_ms']),
      remainingTokens: numOrNull(budget['remaining_tokens']),
      remainingTurns: numOrNull(budget['remaining_turns']),
      remainingWallClockMs: numOrNull(budget['remaining_wall_clock_ms']),
      tokenBudgetReached: budget['token_budget_reached'] === true,
      turnBudgetReached: budget['turn_budget_reached'] === true,
      wallClockBudgetReached: budget['wall_clock_budget_reached'] === true,
      overBudget: budget['over_budget'] === true,
    },
    createdAt: Number(s['created_at'] ?? 0),
    updatedAt: Number(s['updated_at'] ?? 0),
    terminalReason: typeof s['terminal_reason'] === 'string' ? s['terminal_reason'] : undefined,
  };
}
