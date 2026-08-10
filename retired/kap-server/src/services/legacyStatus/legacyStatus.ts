/**
 * `LegacyStatus` types — the v1-style `phase` field of the combined
 * `agent.status.updated` payload.
 *
 * v2's native status events never carry a v1 `phase` (it is a v1-only concept),
 * so it is defined here at the v1 edge that projects it. The v2 service
 * readers (`readLegacyStatus` / `toLegacyPhase`) were retired with the engine
 * migration; only the wire `AgentPhase` type survives for the WS event shape.
 */

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

/**
 * Turn terminal reason (localized from the v2 `agent/loop/turnEvents` type
 * with the engine migration).
 */
export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';
