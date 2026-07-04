/**
 * `externalHooks` domain (L5) — contract for configured external hook
 * commands.
 *
 * The service is intentionally observer-shaped: business domains expose their
 * own minimal hook contexts, and the L5 implementation listens to those hooks
 * to invoke configured external commands.
 */

import { createDecorator } from '#/_base/di';
import type { HookEngine } from './engine';

export interface RenderedExternalHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export interface ExternalHooksServiceOptions {
  readonly hookEngine?:
    | Pick<HookEngine, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'>
    | undefined;
}

export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;

  /**
   * Run the blocking `SubagentStart` external hook for an agent task this
   * agent is launching (via the `Agent` tool / swarm). Called directly by the
   * `agentLifecycle` tool wrapper (`mirrorAgentRun`) — the wrapper is a thin
   * layer over the lifecycle with no hook service of its own, so this is the
   * one context invoked explicitly rather than observed. Throws when a
   * configured hook blocks.
   */
  runAgentTaskStart(ctx: AgentTaskStartHookContext): Promise<void>;
  /** Fire-and-forget `SubagentStop` external hook counterpart. */
  notifyAgentTaskStop(ctx: AgentTaskStopHookContext): void;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
