/**
 * `subagent` domain (L6) — `ISessionSubagentService` contract: driving turns
 * on other agents, plus the hook / event surface those runs announce.
 *
 * Split out of `agentLifecycle`: the lifecycle registry owns *existence*
 * (create / fork / lookup / removal); this domain owns *runs* — one agent
 * driving a turn on another and the requester-side announcements that come
 * with it. The `onWillStartAgentTask` hook slot and the `onDidStopAgentTask`
 * event are run by `mirrorAgentRun` when one agent drives another, so
 * observers such as the Session-scope `externalHooks` adapter can translate
 * them into the `SubagentStart` / `SubagentStop` external hook commands.
 * Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { Turn } from '#/agent/loop/loop';
import type { Hooks } from '#/hooks';

export type AgentRunRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface RunAgentOptions {
  /** Cancellation signal. Aborting it cancels the agent's turn. */
  readonly signal: AbortSignal;
  /**
   * Summary distillation policy. Defaults to the `summaryPolicy` of the
   * profile the target agent is bound to; pass explicitly to override.
   */
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  /** Fires once the turn's first request is committed (used by swarm to fan out). */
  readonly onReady?: () => void;
}

export interface AgentRunHandle {
  readonly agentId: string;
  readonly turn: Turn;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

/** Facts announced when an agent run this session is hosting is about to start. */
export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

/** Facts announced when an agent run this session is hosting has stopped. */
export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
};

export interface ISessionSubagentService {
  readonly _serviceBrand: undefined;

  /**
   * Requester-side agent-run hook slot (`onWillStartAgentTask`) run by
   * `mirrorAgentRun` when one agent drives another. Observers — e.g. the
   * Session-scope `externalHooks` adapter — register here to translate a run
   * into the `SubagentStart` external hook command; a rejecting handler
   * cancels the run. The slot host lives on the service that owns the run;
   * callers never invoke the external hook commands directly.
   */
  readonly hooks: Hooks<AgentTaskHooks>;

  /**
   * Fires after a mirrored agent run has stopped, with the run's distilled
   * summary. Announced by `mirrorAgentRun` via {@link notifyAgentTaskStopped};
   * observers such as the Session-scope `externalHooks` adapter translate it
   * into the `SubagentStop` external hook command.
   */
  readonly onDidStopAgentTask: Event<AgentTaskStopHookContext>;

  /**
   * Submit one prompt (or retry) turn to an existing agent and return a handle
   * whose `completion` resolves with the distilled summary and token usage.
   * Emits nothing on anyone else's record stream — a caller that wants to
   * surface this run (the `Agent` tool, the swarm) mirrors it itself. Throws
   * when the agent does not exist or a turn cannot be started (busy / no head).
   */
  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;

  /**
   * Fire {@link onDidStopAgentTask} for a mirrored run that has stopped.
   * Called by `mirrorAgentRun` once per mirrored run completion; no other
   * caller should invoke it.
   */
  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
}

export const ISessionSubagentService: ServiceIdentifier<ISessionSubagentService> =
  createDecorator<ISessionSubagentService>('sessionSubagentService');
