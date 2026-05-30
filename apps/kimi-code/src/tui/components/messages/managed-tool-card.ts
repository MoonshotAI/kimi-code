import type { Component } from '@earendil-works/pi-tui';

import type { SwarmEvent } from './swarm-dashboard-model';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

/**
 * Narrow shared contract for a card that the streaming-UI managed tool-call
 * lifecycle owns in `_pendingToolComponents` (keyed by tool call id). Both
 * `ToolCallComponent` and `SwarmCard` implement it, so callers can hold a
 * registry value and dispatch the lifecycle methods below polymorphically.
 *
 * The interface is deliberately minimal: it only carries members the callers
 * invoke on the union without first knowing which concrete card they hold.
 * Anything reached only after `isSwarm()` returns false (the whole subagent
 * API, progress lines, plan info, background-task terminal status, …) is left
 * off and accessed via `instanceof ToolCallComponent` narrowing at the call
 * site instead.
 */
export interface ManagedToolCard extends Component {
  /** True iff this card drives the `Swarm` coordinator dashboard. */
  isSwarm(): boolean;

  /**
   * Fold a swarm dashboard event into the card and re-render in place. A safe
   * no-op on a non-swarm card so callers can route blindly after an
   * `isSwarm()` guard without re-narrowing.
   */
  applySwarm(event: SwarmEvent): void;

  /** Deliver the tool result and drive the card to its terminal state. */
  setResult(result: ToolResultBlockData): void;

  /** Re-sync the live tool-call metadata (args, truncation, …). */
  updateToolCall(toolCall: ToolCallBlockData): void;

  /** Tool-output expansion toggle (Ctrl+O). No-op on cards without a body. */
  setExpanded(expanded: boolean): void;

  /**
   * Plan-box expansion toggle. Returns true iff the card actually owns a plan
   * preview (so the caller can decide whether to consume the keystroke).
   */
  setPlanExpanded(expanded: boolean): boolean;

  /** Release any timers/resources. Must be safe to call more than once. */
  dispose(): void;

  /** Readonly view of the backing tool call (id, name, description). */
  readonly toolCallView: Readonly<ToolCallBlockData>;
}
