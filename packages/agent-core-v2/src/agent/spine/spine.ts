import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { SpineEpochArchiveInput } from './spineArchive';
import type { SpineState } from './spineOps';
import type { SpineTrimOp } from './spineTrimDerive';

export const SPINE_TOOL_OPEN = 'spine_open';
export const SPINE_TOOL_CLOSE = 'spine_close';
export const SPINE_TOOL_NEXT = 'spine_next';
export const SPINE_TOOL_TREE = 'spine_tree';
export const SPINE_TOOL_TRIM = 'spine_trim';
export const SPINE_TOOL_SPAWN = 'spine_spawn';

/**
 * All six spine tool names. Profiles whitelist these so the main agent's
 * active-tool filter lets the registered tools through; surfaces that merely
 * display a profile's tool list (e.g. the `Agent` tool description) filter
 * them out instead, since the tools register only for the main agent.
 * `spine_trim` and `spine_spawn` are NOT control tools: they carry no tree
 * transition and are gated on separate flags.
 */
export const SPINE_TOOL_NAMES = [
  SPINE_TOOL_OPEN,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_TREE,
  SPINE_TOOL_TRIM,
  SPINE_TOOL_SPAWN,
] as const;

export type SpineControlToolName =
  | typeof SPINE_TOOL_OPEN
  | typeof SPINE_TOOL_CLOSE
  | typeof SPINE_TOOL_NEXT;

export interface SpineSpawnTaskInput {
  readonly summary: string;
  readonly prompt: string;
}

export interface SpineTransitionAccepted {
  readonly accepted: true;
}

export interface SpineTransitionRejected {
  readonly accepted: false;
  readonly reason: string;
}

export type SpineTransitionResult = SpineTransitionAccepted | SpineTransitionRejected;

export interface IAgentSpineService {
  readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  acceptOpen(summary: string): SpineTransitionResult;
  acceptClose(memory: string): SpineTransitionResult;
  acceptNext(summary: string, memory: string): SpineTransitionResult;

  /**
   * Validates a `spine_trim` call against the derived trim projection (the
   * single eligibility source): unknown, consumed, out-of-window, or
   * anchor-missing ids reject with a do-not-retry reason. Not a transition —
   * no per-step budget; the accepted receipt in history IS the trim.
   */
  acceptTrim(trimId: string, op: SpineTrimOp): SpineTransitionResult;

  /**
   * Executes a `spine_spawn` fission: forks one child agent per task, runs them
   * in parallel, and returns a structured JSON receipt. The receipt landing in
   * history IS the join; derive synthesizes the closed child nodes from it.
   * Capacity-shortfall admission is reported inside the receipt as per-task
   * errored results (no branches start); validation rejections surface their
   * reasons as errors so the model can retry.
   */
  executeSpawn(
    tasks: readonly SpineSpawnTaskInput[],
    signal: AbortSignal,
  ): Promise<SpineTransitionResult & { readonly receipt?: string }>;

  archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined>;

  renderTree(): string;

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[];

  /** The current tree state, derived from the message stream on read. */
  currentState(): SpineState;
}

export const IAgentSpineService = createDecorator<IAgentSpineService>('agentSpineService');
