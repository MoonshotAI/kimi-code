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
  readonly binding?: BindAgentInput;
  readonly permissionMode?: PermissionMode;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ForkAgentOptions {
  readonly agentId?: string;
  readonly binding?: Partial<BindAgentInput>;
}

export type AgentRunRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface RunAgentOptions {
  readonly signal: AbortSignal;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
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

export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
};

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<AgentTaskHooks>;

  readonly onDidStopAgentTask: Event<AgentTaskStopHookContext>;

  readonly onDidCreate: Event<IAgentScopeHandle>;
  readonly onDidCreateMain: Event<IAgentScopeHandle>;
  readonly onDidDispose: Event<string>;
  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;
  whenReady(agentId: string): Promise<IAgentScopeHandle | undefined>;
  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;
  notifyMainCreated(handle: IAgentScopeHandle): void;
  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;
  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;
  getHandle(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');
