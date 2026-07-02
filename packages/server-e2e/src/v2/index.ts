/**
 * `@moonshot-ai/server-e2e` v2 SDK — a lark-style, typed client for the
 * `server-v2` `/api/v2` RPC + WS surface.
 *
 *   import { ServerClient } from '@moonshot-ai/server-e2e';
 *
 *   const sdk = new ServerClient({ baseUrl: 'http://127.0.0.1:58627', token });
 *   const { items } = await sdk.sessions.list({ page_size: 20 });
 *   await sdk.session(items[0].id).setTitle('renamed');
 *   await sdk.session(items[0].id).agent('main').prompts.submit({ input: [...] });
 *
 *   const events = await sdk.connect();
 *   const off = events.onAgentEvents(sid, 'main', (e) => { ... });
 *
 * The legacy `/api/v1` REST surface is reachable via `sdk.v1`.
 */
export { ServerClient } from './client.js';
export type { ServerClientOptions } from './client.js';

export { SessionScope } from './resources/session.js';
export { AgentScope } from './resources/agent.js';
export { EventsClient } from './resources/events.js';
export type { Unlisten } from './resources/events.js';

export type {
  CoreResources,
  SessionsResource,
  WorkspacesResource,
  ConfigResource,
  ProvidersResource,
  OAuthResource,
  AuthResource,
  FlagsResource,
  PluginsResource,
  CoreFsResource,
  MetaResource,
} from './resources/core.js';
export type {
  SessionResource,
  ApprovalsResource,
  QuestionsResource,
  InteractionsResource,
  SessionWorkspaceResource,
  AgentFsResource,
  SessionFsResource,
} from './resources/session.js';
export type {
  GoalResource,
  PlanResource,
  TasksResource,
  UsageResource,
  ContextResource,
  SwarmResource,
  PermissionResource,
  PermissionRulesResource,
  ProfileResource,
  MessagesResource,
  ToolStoreResource,
  McpResource,
  ToolsResource,
  PromptsResource,
  ShellResource,
  AgentPluginsResource,
} from './resources/agent.js';

export type {
  SessionMeta,
  SessionActivityStatus,
  WorkspaceInfo,
  ListResult,
  PromptSubmitArg,
  PromptInputPart,
  PromptSubmitResult,
  ShellRunArg,
  ShellRunResult,
} from './resources/types.js';

export { CORE, SESSION, AGENT, flattenManifest } from './resources/manifest.js';
export type { CoreManifest, SessionManifest, AgentManifest } from './resources/manifest.js';

export { HttpRpc } from './transport/http.js';
export type { HttpRpcOptions, ScopeKind, ScopeParams } from './transport/http.js';
export {
  makeResource,
  makeDynamicResource,
  type ActionMeta,
  type AnyMethod,
  type DynamicResource,
  type ResourceShape,
} from './transport/rpcProxy.js';
export { V2Socket } from './transport/ws.js';
export type { V2SocketOptions } from './transport/ws.js';

export { RpcError, unwrapData } from './errors.js';
