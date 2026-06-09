/**
 * `SessionService` — implementation of `ISessionService`.
 */

import {
  Disposable,
  Emitter,
  IInstantiationService,
  InstantiationType,
  registerSingleton,
} from '@moonshot-ai/agent-core';
import type { JsonObject, SessionMeta } from '@moonshot-ai/agent-core';
import {
  type CompactSessionRequest,
  type CompactSessionResponse,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatusResponse,
  type SessionUpdate,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IPromptService, type AgentStatePatch } from '../prompt/prompt';
import {
  ISessionService,
  SessionNotFoundError,
  toProtocolSession,
  type SessionListQuery,
} from './session';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const CHILD_SESSION_KIND = 'child';

/**
 * Treat the incoming `metadata` object — schema-validated by zod as
 * `{cwd: string}` plus arbitrary `unknown` keys — as a JSON-safe object for
 * agent-core's `JsonObject` slot. We don't deep-validate here; clients can
 * send non-JSON-serializable values and agent-core will reject at the RPC
 * boundary. This cast keeps the adapter narrow and the wire stable.
 */
function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  /**
   * VSCode-style Emitter for session-creation events. Listener exceptions
   * route to `onUnexpectedError` inside `Emitter.fire()`. Owned via
   * `_register(...)` so it disposes when the service is torn down.
   */
  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  /**
   * VSCode-style Emitter for session-close events. Same ownership +
   * exception-routing semantics as `_onDidCreate`.
   */
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IInstantiationService
    private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  async create(input: SessionCreate): Promise<Session> {
    // The protocol schema now allows `metadata` to be omitted (so callers can
    // send `{ workspace_id }` only). The daemon route layer is responsible
    // for resolving workspace_id → workspace.root → metadata.cwd BEFORE
    // calling this method; by the time we land here `metadata.cwd` must be
    // set. agent-core's `createSession` calls `requiredWorkDir(...)` and
    // throws if cwd is missing, so a missing-cwd bug surfaces as a
    // descriptive error rather than silently picking the daemon's cwd.
    if (input.metadata === undefined || typeof input.metadata.cwd !== 'string') {
      throw new Error('SessionService.create: metadata.cwd is required');
    }
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      ...(input.agent_config?.model !== undefined ? { model: input.agent_config.model } : {}),
    });
    // agent-core's createSession ignores any caller-supplied title — newly
    // created sessions get the default `SessionMeta.title = 'New Session'`.
    // When the caller supplied a title we apply it via `renameSession` so the
    // post-create get reflects it.
    if (input.title !== undefined) {
      try {
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
        // If rename fails (e.g. session closed/race), continue with the
        // default — the response shape is unchanged.
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    // Fire onDidCreate listeners after the core RPC resolves.
    this._onDidCreate.fire({ session });
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    // Fast path: when caller supplies a workDir (typically from `?workspace_id=`
    // resolving to a workspace.root), agent-core's `listSessions({workDir})`
    // walks a single wd-key bucket via readdir instead of scanning every
    // workdir. Otherwise we list everything and apply downstream filters.
    const all =
      query.workDir !== undefined
        ? await this.core.rpc.listSessions({ workDir: query.workDir })
        : await this.core.rpc.listSessions({});
    // Sort by createdAt desc per REST §1.6 "最近 N 条（按 created_at desc）".
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);

    // Cursor: anchor on id. before_id = older than that id; after_id = newer.
    // Because the underlying list is desc, "older" = AFTER in the array.
    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof sorted;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Hydrate each summary with its metadata. We do these in parallel —
    // `getSessionMetadata` is in-memory once the session is loaded, so the
    // round-trip count is what matters, not bandwidth.
    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );

    // Apply post-hydration status filter if requested. Today all sessions
    // are mapped to 'idle' (see header note); the filter is wired now so the
    // wire contract is stable when agent-core surfaces a real status enum.
    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summary, meta);
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    // Existence check first — gives a deterministic 40401 if the id is wrong.
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // 1) title goes through renameSession.
    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    // 2) metadata patches go through updateSessionMetadata. agent-core's
    //    SessionMeta has top-level `title` + `custom`; we route protocol's
    //    `metadata` (catchall) into `custom` so it round-trips on the next get.
    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    // 3) agent_config runtime controls — route the four fields (model,
    //    thinking, permission_mode, plan_mode) through the per-session
    //    shadow on `IPromptService.applyAgentState`. The helper diff-
    //    dispatches against the shadow and writes a dispatch-log entry
    //    with `source='meta'` for any setter that actually fires.
    //    Resolution is lazy via `IInstantiationService` to break the
    //    ctor cycle (`PromptService` already injects `ISessionService`).
    const ac = input.agent_config;
    if (ac !== undefined) {
      const patch: AgentStatePatch = {};
      // SessionService.update has long accepted `agent_config.model` and
      // treated empty string as "no change" — we preserve that quirk by
      // dropping the empty case before forwarding to the shadow.
      if (ac.model !== undefined && ac.model !== '') patch.model = ac.model;
      if (ac.thinking !== undefined) patch.thinking = ac.thinking;
      if (ac.permission_mode !== undefined) patch.permission_mode = ac.permission_mode;
      if (ac.plan_mode !== undefined) patch.plan_mode = ac.plan_mode;
      if (
        patch.model !== undefined ||
        patch.thinking !== undefined ||
        patch.permission_mode !== undefined ||
        patch.plan_mode !== undefined
      ) {
        const promptService = this.instantiation.invokeFunction((a) =>
          a.get(IPromptService),
        );
        await promptService.applyAgentState(id, patch, 'meta');
      }
    }

    // 4) permission_rules: no CoreAPI surface yet — we accept the input
    //    (schema-validated) but no CoreAPI surface exists to persist them yet.

    // Re-fetch to return the post-update Session.
    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summaryAfter, meta);
  }

  async fork(id: string, input: SessionFork): Promise<Session> {
    const source = await this.get(id);
    const title = input.title ?? `Fork: ${source.title || source.id}`;
    const metadata = input.metadata === undefined ? undefined : asJsonObject(input.metadata);
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    this._onDidCreate.fire({ session });
    return session;
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    await this.get(id);
    const all = await this.core.rpc.listSessions({});
    const sorted = all.toSorted((a, b) => b.createdAt - a.createdAt);
    const children = sorted.filter(
      (summary) =>
        summary.metadata?.['parent_session_id'] === id &&
        summary.metadata?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof children;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );
    const filtered =
      query.status !== undefined
        ? items.filter((session) => session.status === query.status)
        : items;

    return {
      items: filtered,
      has_more: slice.length > pageSize,
    };
  }

  async createChild(id: string, input: SessionChildCreate): Promise<Session> {
    const parent = await this.get(id);
    const title = input.title ?? `Child: ${parent.title || parent.id}`;
    const metadata = asJsonObject({
      ...input.metadata,
      parent_session_id: id,
      child_session_kind: CHILD_SESSION_KIND,
    });
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    this._onDidCreate.fire({ session });
    return session;
  }

  async getStatus(id: string): Promise<SessionStatusResponse> {
    // Existence check — same pattern as get() / update() / delete().
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const [config, context, permission, plan] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getContext({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPermission({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPlan({ sessionId: id, agentId: 'main' }),
    ]);

    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    return {
      model: config.modelAlias ?? config.provider?.model,
      thinking_level: config.thinkingLevel,
      permission: permission.mode,
      plan_mode: plan !== null,
      context_tokens: contextTokens,
      max_context_tokens: maxContextTokens,
      context_usage: contextUsage,
    };
  }

  async compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const instruction = normalizeOptionalString(input.instruction);
    await this.core.rpc.beginCompaction({
      sessionId: id,
      agentId: 'main',
      instruction,
    });
    return {};
  }

  async delete(id: string): Promise<{ deleted: true }> {
    // Existence check — deterministic 40401 even on close.
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.closeSession({ sessionId: id });
    // Fire onDidClose listeners after the core RPC resolves.
    this._onDidClose.fire({ sessionId: id });
    return { deleted: true };
  }

  /**
   * Pull a session's metadata; swallow errors (session may not be loaded into
   * the active session map yet, in which case `sessionApi(id)` throws). The
   * caller falls back to defaults from the summary alone.
   */
  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.core.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }

  // --- Per-domain event accessors -------------------------------------------
  //
  // `onDidCreate` / `onDidClose` are declared above as
  // `Emitter<T>.event` getters; consumers subscribe via
  // `svc.onDidCreate(handler)` (returns IDisposable) and own the
  // detach lifetime through `Disposable._register(...)`.

  override dispose(): void {
    if (this._isDisposed) return;
    // `_onDidCreate` and `_onDidClose` are registered via `this._register(...)`,
    // so `super.dispose()` flushes their listeners.
    super.dispose();
  }
}

// Self-register under the global singleton registry. Daemon-side bootstrap
// projects this through `defaultServicesModule()` /
// `getSingletonServiceDescriptors()`. All ctor deps are `@I…`-injected, so
// `staticArguments` is `[]`. `supportsDelayedInstantiation = false` preserves
// current reverse-dispose semantics.
registerSingleton(ISessionService, SessionService, InstantiationType.Delayed);
