/**
 * Session-scope resources — `/api/v2/session/<sid>/<resource>:<action>`.
 *
 * The `session` resource (read/update/setTitle/setArchived/status/isIdle/
 * archive) is flattened onto the {@link SessionScope} handle itself, since it
 * is the primary thing you do with a session; every other resource
 * (`approvals`, `questions`, `interactions`, `workspace`, `fs`) is
 * a sub-namespace. `agent(agentId)` enters the agent scope, and
 * `service<T>(resource)` is the escape hatch for actions not in the manifest.
 */
import type { HttpRpc } from '../transport/http.js';
import {
  type AnyMethod,
  type DynamicResource,
  makeDynamicResource,
  makeResource,
  type ResourceShape,
} from '../transport/rpcProxy.js';

import { AgentScope } from './agent.js';
import { SESSION, type SessionManifest } from './manifest.js';
import type {
  SessionActivityStatus,
  SessionMeta,
  SessionResourcePrecise,
} from './types.js';

export type SessionResource = ResourceShape<SessionManifest['session'], SessionResourcePrecise>;
export type ApprovalsResource = ResourceShape<SessionManifest['approvals']>;
export type QuestionsResource = ResourceShape<SessionManifest['questions']>;
export type InteractionsResource = ResourceShape<SessionManifest['interactions']>;
export type SessionWorkspaceResource = ResourceShape<SessionManifest['workspace']>;
export type SessionFsResource = ResourceShape<SessionManifest['fs']>;

/** Session scope handle — obtained via `client.session(sessionId)`. */
export class SessionScope {
  readonly approvals: ApprovalsResource;
  readonly questions: QuestionsResource;
  readonly interactions: InteractionsResource;
  readonly workspace: SessionWorkspaceResource;
  readonly fs: SessionFsResource;

  private readonly sessionResource: SessionResource;

  constructor(
    private readonly rpc: HttpRpc,
    readonly sessionId: string,
  ) {
    const params = { sessionId };
    this.sessionResource = makeResource<SessionManifest['session'], SessionResourcePrecise>(
      rpc,
      'session',
      params,
      'session',
      SESSION.session,
    );
    this.approvals = makeResource(rpc, 'session', params, 'approvals', SESSION.approvals);
    this.questions = makeResource(rpc, 'session', params, 'questions', SESSION.questions);
    this.interactions = makeResource(rpc, 'session', params, 'interactions', SESSION.interactions);
    this.workspace = makeResource(rpc, 'session', params, 'workspace', SESSION.workspace);
    this.fs = makeResource(rpc, 'session', params, 'fs', SESSION.fs);
  }

  // ── Flattened `session` resource ─────────────────────────────────────────
  read(arg?: unknown): Promise<SessionMeta> {
    return this.sessionResource.read(arg);
  }
  update(arg?: unknown): Promise<SessionMeta> {
    return this.sessionResource.update(arg);
  }
  setTitle(arg?: string): Promise<null> {
    return this.sessionResource.setTitle(arg);
  }
  setArchived(arg?: boolean): Promise<null> {
    return this.sessionResource.setArchived(arg);
  }
  status(arg?: unknown): Promise<SessionActivityStatus> {
    return this.sessionResource.status(arg);
  }
  isIdle(arg?: unknown): Promise<boolean> {
    return this.sessionResource.isIdle(arg);
  }
  archive(arg?: unknown): Promise<null> {
    return this.sessionResource.archive(arg ?? this.sessionId);
  }

  /** Enter the agent scope for `agentId`. */
  agent(agentId: string): AgentScope {
    return new AgentScope(this.rpc, this.sessionId, agentId);
  }

  /** Escape hatch for a session resource not (yet) in the manifest. */
  service<T extends Record<string, AnyMethod> = DynamicResource>(resource: string): T {
    return makeDynamicResource(this.rpc, 'session', { sessionId: this.sessionId }, resource) as T;
  }
}
