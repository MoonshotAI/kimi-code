/**
 * Agent-scope resources — `/api/v2/session/<sid>/agent/<aid>/<resource>:<action>`.
 *
 * Exposes one typed resource per entry in the `AGENT` manifest, plus a
 * `service<T>(resource)` escape hatch for actions not (yet) in the manifest.
 */
import type { HttpRpc } from '../transport/http.js';
import {
  type AnyMethod,
  type DynamicResource,
  makeDynamicResource,
  makeResource,
  type ResourceShape,
} from '../transport/rpcProxy.js';

import { AGENT, type AgentManifest } from './manifest.js';
import type { ProfilePrecise, PromptsPrecise, ShellPrecise } from './types.js';

export type GoalResource = ResourceShape<AgentManifest['goal']>;
export type PlanResource = ResourceShape<AgentManifest['plan']>;
export type TasksResource = ResourceShape<AgentManifest['tasks']>;
export type UsageResource = ResourceShape<AgentManifest['usage']>;
export type ContextResource = ResourceShape<AgentManifest['context']>;
export type SwarmResource = ResourceShape<AgentManifest['swarm']>;
export type PermissionResource = ResourceShape<AgentManifest['permission']>;
export type PermissionRulesResource = ResourceShape<AgentManifest['permissionRules']>;
export type ProfileResource = ResourceShape<AgentManifest['profile'], ProfilePrecise>;
export type MessagesResource = ResourceShape<AgentManifest['messages']>;
export type ToolStoreResource = ResourceShape<AgentManifest['toolStore']>;
export type McpResource = ResourceShape<AgentManifest['mcp']>;
export type ToolsResource = ResourceShape<AgentManifest['tools']>;
export type PromptsResource = ResourceShape<AgentManifest['prompts'], PromptsPrecise>;
export type ShellResource = ResourceShape<AgentManifest['shell'], ShellPrecise>;
export type AgentPluginsResource = ResourceShape<AgentManifest['plugins']>;

/** Agent scope handle — obtained via `session.agent(agentId)`. */
export class AgentScope {
  readonly goal: GoalResource;
  readonly plan: PlanResource;
  readonly tasks: TasksResource;
  readonly usage: UsageResource;
  readonly context: ContextResource;
  readonly swarm: SwarmResource;
  readonly permission: PermissionResource;
  readonly permissionRules: PermissionRulesResource;
  readonly profile: ProfileResource;
  readonly messages: MessagesResource;
  readonly toolStore: ToolStoreResource;
  readonly mcp: McpResource;
  readonly tools: ToolsResource;
  readonly prompts: PromptsResource;
  readonly shell: ShellResource;
  readonly plugins: AgentPluginsResource;

  constructor(
    private readonly rpc: HttpRpc,
    readonly sessionId: string,
    readonly agentId: string,
  ) {
    const params = { sessionId, agentId };
    this.goal = makeResource(rpc, 'agent', params, 'goal', AGENT.goal);
    this.plan = makeResource(rpc, 'agent', params, 'plan', AGENT.plan);
    this.tasks = makeResource(rpc, 'agent', params, 'tasks', AGENT.tasks);
    this.usage = makeResource(rpc, 'agent', params, 'usage', AGENT.usage);
    this.context = makeResource(rpc, 'agent', params, 'context', AGENT.context);
    this.swarm = makeResource(rpc, 'agent', params, 'swarm', AGENT.swarm);
    this.permission = makeResource(rpc, 'agent', params, 'permission', AGENT.permission);
    this.permissionRules = makeResource(
      rpc,
      'agent',
      params,
      'permissionRules',
      AGENT.permissionRules,
    );
    this.profile = makeResource<AgentManifest['profile'], ProfilePrecise>(
      rpc,
      'agent',
      params,
      'profile',
      AGENT.profile,
    );
    this.messages = makeResource(rpc, 'agent', params, 'messages', AGENT.messages);
    this.toolStore = makeResource(rpc, 'agent', params, 'toolStore', AGENT.toolStore);
    this.mcp = makeResource(rpc, 'agent', params, 'mcp', AGENT.mcp);
    this.tools = makeResource(rpc, 'agent', params, 'tools', AGENT.tools);
    this.prompts = makeResource<AgentManifest['prompts'], PromptsPrecise>(
      rpc,
      'agent',
      params,
      'prompts',
      AGENT.prompts,
    );
    this.shell = makeResource<AgentManifest['shell'], ShellPrecise>(
      rpc,
      'agent',
      params,
      'shell',
      AGENT.shell,
    );
    this.plugins = makeResource(rpc, 'agent', params, 'plugins', AGENT.plugins);
  }

  /** Escape hatch for an agent resource not (yet) in the manifest. */
  service<T extends Record<string, AnyMethod> = DynamicResource>(resource: string): T {
    return makeDynamicResource(
      this.rpc,
      'agent',
      { sessionId: this.sessionId, agentId: this.agentId },
      resource,
    ) as T;
  }
}
