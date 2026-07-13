/**
 * `agentLifecycle` domain (L6) — flat registry of the session's agents.
 *
 * Defines the public contract of agent lifecycle: `create` (from zero, Profile
 * + Model), `fork` (inherit binding + context history), `run` (drive one
 * prompt/retry turn on an agent and await its distilled summary), plus lookup
 * (`getHandle` / `list`) and removal. Hosts the requester-side agent-run hook
 * slot (`hooks.onWillStartAgentTask`) and stop announcement
 * (`onDidStopAgentTask`) that `mirrorAgentRun` runs when one agent drives
 * another, so observers such as the Session-scope `externalHooks` adapter can
 * translate them into external hook commands. Session-scoped — one instance
 * per session.
 *
 * Invariants:
 * - The registry is flat: agents have no nesting. There is no parent/child or
 *   caller/callee relationship here; when a business domain needs such a
 *   relationship (e.g. the `Agent` tool's display events), that domain
 *   maintains it itself.
 * - The main agent is an ordinary agent whose only distinction is
 *   `agentId === 'main'`. Business operations (create / fork / run / lookup)
 *   treat it uniformly; the only main-specific surface is the
 *   `onDidCreateMain` event, fired idempotently via `notifyMainCreated` by the
 *   main bootstrapper so main-only capabilities subscribe without filtering
 *   every `onDidCreate`.
 * - Creation is single-flight per explicit agent id, and readiness lookups
 *   return only settled handles.
 * - `forkedFrom` is provenance only (a recorded value); business logic must
 *   not branch on it.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { Turn } from '#/agent/loop/loop';
import type { Hooks } from '#/hooks';

export interface CreateAgentOptions {
  readonly agentId?: string;
  /**
   * Profile + Model to bind at creation so the agent is born runnable
   * (`Profile + Model ⇒ Agent`). May be omitted by exactly two callers:
   * session resume/fork (the binding is restored from the wire log) and the
   * edge-bootstrapped main agent (the edge binds a model right after). Every
   * other creation path must pass a full binding.
   */
  readonly binding?: BindAgentInput;
  /**
   * Initial permission mode for the new agent. Used by subagent dispatch
   * (`Agent` / `AgentSwarm`) so a child inherits its caller's mode instead of
   * falling back to the model default (`manual`). Applied right after binding,
   * before the handle is returned — i.e. before any turn runs.
   */
  readonly permissionMode?: PermissionMode;
  /** Agent this one is derived from (provenance only; not used by business logic). */
  readonly forkedFrom?: string;
  /**
   * Business-defined recorded values (e.g. the swarm's `swarmItem`). Persisted
   * verbatim into the session's agent registry; never interpreted here.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ForkAgentOptions {
  readonly agentId?: string;
  /**
   * Overrides merged over the source agent's binding (e.g. a title generator
   * forking `main` onto a cheaper model).
   */
  readonly binding?: Partial<BindAgentInput>;
}

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

export interface AgentListFilter {
  readonly prefix?: string;
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

export interface IAgentLifecycleService {
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

  /** Fires after an agent is created and registered, with its scope handle. */
  readonly onDidCreate: Event<IAgentScopeHandle>;
  /**
   * Fires once after the main agent is created and its main-only wirings are
   * attached, with its scope handle. Use this instead of `onDidCreate` when a
   * capability belongs exclusively to the main agent, so subscribers do not
   * need to filter every agent creation by `id === 'main'`.
   */
  readonly onDidCreateMain: Event<IAgentScopeHandle>;
  /** Fires after an agent is removed, with its agent id. */
  readonly onDidDispose: Event<string>;
  /** Create an agent from zero (empty context). */
  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;
  whenReady(agentId: string): Promise<IAgentScopeHandle | undefined>;
  /**
   * Resolve the session MCP config (file config + caller-supplied servers, with
   * plugin servers on top) and wait for the initial connection attempt to
   * finish. Per-server failures are reflected in MCP status entries rather than
   * rejecting this promise. `callerServers` is honored only by the call that
   * starts the initial load — `sessionLifecycle.materializeSession` passes the
   * session's caller-supplied servers there; later callers (e.g. agent
   * creation) just await the in-flight load.
   */
  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;
  notifyMainCreated(handle: IAgentScopeHandle): void;
  /**
   * Fire {@link onDidStopAgentTask} for a mirrored run that has stopped.
   * Called by `mirrorAgentRun` once per mirrored run completion; no other
   * caller should invoke it.
   */
  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
  /**
   * Fork an agent: copy its profile binding and context history into a new
   * agent, recording `forkedFrom = sourceAgentId`. Throws when the source does
   * not exist.
   */
  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;
  /**
   * Submit one prompt (or retry) turn to an existing agent and return a handle
   * whose `completion` resolves with the distilled summary and token usage.
   * Emits nothing on anyone else's record stream — a caller that wants to
   * surface this run (the `Agent` tool, the swarm) mirrors it itself. Throws
   * when the agent does not exist or a turn cannot be started (busy / no head).
   */
  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;
  getHandle(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');
