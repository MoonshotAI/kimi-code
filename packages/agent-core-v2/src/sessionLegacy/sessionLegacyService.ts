/**
 * `sessionLegacy` domain — `ISessionLegacyService` implementation.
 *
 * Stateless Core-scope dispatcher: each method resolves the target session (and
 * its main agent) per call, delegates to the native v2 services, and projects
 * the result into the v1 wire shape. Child sessions are implemented as forks
 * tagged in `custom` (`parent_session_id` + `child_session_kind`); listing reads
 * those markers from the `session-index` summaries. No business logic is
 * duplicated here; the real work stays in the native services.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle';
import { IAuthSummaryService } from '#/auth';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { IContextSizeService } from '#/contextSize';
import { ErrorCodes, isKimiError, KimiError } from '#/errors';
import { IFullCompaction } from '#/fullCompaction';
import { IPermissionModeService } from '#/permissionMode';
import { IPlanService } from '#/plan';
import { IProfileService } from '#/profile';
import { IPromptService } from '#/prompt';
import { IAgentRPCService } from '#/rpc';
import { ISessionActivity } from '#/session-activity';
import { ISessionContext } from '#/session-context';
import { ISessionIndex, type SessionSummary } from '#/session-index';
import { ISessionLifecycleService } from '#/session-lifecycle';
import { ISessionMetadata } from '#/session-metadata';
import { ISwarmService } from '#/swarm';
import { IWorkspaceRegistry } from '#/workspaceRegistry';
import type {
  CompactSessionRequest,
  CompactSessionResponse,
  CreateSessionChildRequest,
  ForkSessionRequest,
  SessionAbortResponse,
  StartBtwSessionResponse,
  UndoSessionRequest,
} from '@moonshot-ai/protocol';

import {
  ISessionLegacyService,
  type SessionChildrenPage,
  type SessionChildrenQuery,
  type SessionStatusData,
  type SessionWireFields,
  type UndoResult,
} from './sessionLegacy';

const MAIN_AGENT_ID = 'main';

/**
 * v1 `child_session_kind` marker (`packages/agent-core/.../sessionService.ts`).
 * A fork is only listed as a "child" when its metadata carries both
 * `parent_session_id` (the parent) and `child_session_kind === 'child'`; a
 * spoofed kind is ignored. Reused verbatim so v1/v2 agree on the tag.
 */
const CHILD_SESSION_KIND = 'child';

const CHILDREN_DEFAULT_PAGE_SIZE = 100;
const CHILDREN_MAX_PAGE_SIZE = 100;

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
    @IAuthSummaryService private readonly auth: IAuthSummaryService,
  ) {}

  async fork(sessionId: string, body: ForkSessionRequest): Promise<SessionWireFields> {
    const handle = await this.lifecycle.fork({
      sourceSessionId: sessionId,
      title: body.title,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    const workspace = await this.workspaceRegistry.get(workspaceId);
    return {
      id: meta.id,
      workspaceId,
      root: workspace?.root ?? '',
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      custom: meta.custom,
    };
  }

  async createChild(sessionId: string, body: CreateSessionChildRequest): Promise<SessionWireFields> {
    const parentTitle = await this.resolveParentTitle(sessionId);
    const handle = await this.lifecycle.fork({
      sourceSessionId: sessionId,
      title: body.title ?? `Child: ${parentTitle || sessionId}`,
      metadata: {
        ...(body.metadata ?? {}),
        parent_session_id: sessionId,
        child_session_kind: CHILD_SESSION_KIND,
      },
    });
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    const workspace = await this.workspaceRegistry.get(workspaceId);
    return {
      id: meta.id,
      workspaceId,
      root: workspace?.root ?? '',
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      custom: meta.custom,
    };
  }

  async listChildren(sessionId: string, query: SessionChildrenQuery): Promise<SessionChildrenPage> {
    const exists =
      this.lifecycle.get(sessionId) !== undefined ||
      (await this.index.get(sessionId)) !== undefined;
    if (!exists) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    // v1 lists every session then filters by the `parent_session_id` +
    // `child_session_kind` markers (carried in `custom`); the index summary
    // already surfaces `custom`, so no per-session document read is needed.
    const all = await this.index.list({});
    const children = all.items.filter(
      (s) =>
        s.custom?.['parent_session_id'] === sessionId &&
        s.custom?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: SessionSummary[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const pageSize = Math.min(
      Math.max(query.page_size ?? CHILDREN_DEFAULT_PAGE_SIZE, 1),
      CHILDREN_MAX_PAGE_SIZE,
    );
    const page = slice.slice(0, pageSize);
    const items = await Promise.all(page.map((s) => this.projectSummary(s)));
    // `status` is accepted for wire compatibility but not applied — the v2
    // realtime status is not projected into the index summary, and the wire
    // projection reports a hardcoded 'idle' (matches `GET /sessions`).
    return { items, has_more: slice.length > pageSize };
  }

  async compact(sessionId: string, body: CompactSessionRequest): Promise<CompactSessionResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    const instruction = normalizeOptional(body.instruction);
    // `begin` returns false when busy / over the per-turn limit — v1 treats
    // that as a silent success. It throws `compaction.unable` when there is no
    // compactable prefix, which we let propagate.
    agent.accessor.get(IFullCompaction).begin({ source: 'manual', instruction });
    return {};
  }

  async undo(sessionId: string, body: UndoSessionRequest): Promise<UndoResult> {
    const agent = await this.resolveMainAgent(sessionId);
    const context = agent.accessor.get(IContextMemory);
    const before = context.get();
    const { count } = body;
    if (!canUndoHistory(before, count)) {
      throw new KimiError(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        `Nothing to undo in session ${sessionId}`,
      );
    }
    try {
      agent.accessor.get(IPromptService).undo(count);
    } catch (error) {
      if (isKimiError(error) && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new KimiError(ErrorCodes.SESSION_UNDO_UNAVAILABLE, error.message);
      }
      throw error;
    }
    const history = context.get();
    const status = await this.assembleStatus(sessionId, agent);
    return { history, status };
  }

  async abort(sessionId: string): Promise<SessionAbortResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    // No turnId → cancel whatever turn is active; a safe no-op when idle.
    await agent.accessor.get(IAgentRPCService).cancel({});
    // v1 always reports success once the session exists.
    return { aborted: true };
  }

  async startBtw(sessionId: string): Promise<StartBtwSessionResponse> {
    if (this.lifecycle.get(sessionId) === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    await this.auth.ensureReady();
    const agent = await this.resolveMainAgent(sessionId);
    const agentId = await agent.accessor.get(IAgentRPCService).startBtw({});
    return { agent_id: agentId };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Best-effort parent title for the default `Child: <title>` name. Reads the
   * live handle first, then falls back to the persisted index. A missing parent
   * yields `undefined`; `lifecycle.fork` still throws `SESSION_NOT_FOUND` for
   * the real existence check.
   */
  private async resolveParentTitle(sessionId: string): Promise<string | undefined> {
    const live = this.lifecycle.get(sessionId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sessionId))?.title;
  }

  private async projectSummary(summary: SessionSummary): Promise<SessionWireFields> {
    const workspace = await this.workspaceRegistry.get(summary.workspaceId);
    return {
      id: summary.id,
      workspaceId: summary.workspaceId,
      root: workspace?.root ?? '',
      title: summary.title,
      lastPrompt: summary.lastPrompt,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      custom: summary.custom,
    };
  }

  /**
   * Resolve the session's main agent, creating it on demand (mirrors v1's
   * `resumeSession` + the server-v2 `ensureMainAgent` helper).
   */
  private async resolveMainAgent(sessionId: string): Promise<IScopeHandle> {
    const session = this.lifecycle.get(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const agents = session.accessor.get(IAgentLifecycleService);
    const existing = agents.getHandle(MAIN_AGENT_ID);
    if (existing !== undefined) return existing;
    return agents.createMain();
  }

  private async assembleStatus(sessionId: string, agent: IScopeHandle): Promise<SessionStatusData> {
    const session = this.lifecycle.get(sessionId);
    const profile = agent.accessor.get(IProfileService);
    const contextSize = agent.accessor.get(IContextSizeService);
    const permission = agent.accessor.get(IPermissionModeService);
    const plan = agent.accessor.get(IPlanService);
    const swarm = agent.accessor.get(ISwarmService);

    const profileData = profile.data();
    const model = profile.getModel();
    const caps = profile.getModelCapabilities() as { max_context_tokens?: number };
    const maxTokens = caps.max_context_tokens ?? 0;
    const tokens = contextSize.getStatus().contextTokens;
    const planData = await plan.status();

    return {
      status: session?.accessor.get(ISessionActivity).status() ?? 'idle',
      model: model === '' ? undefined : model,
      thinking_level: profileData.thinkingLevel,
      permission: permission.mode,
      plan_mode: planData !== null,
      swarm_mode: swarm.isActive,
      context_tokens: tokens,
      max_context_tokens: maxTokens,
      context_usage: maxTokens > 0 ? tokens / maxTokens : 0,
    };
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * v1 `canUndoHistory`: scan from the end, skipping injections, stopping at a
 * compaction summary, and counting real user prompts until `count` is met.
 */
function canUndoHistory(history: readonly ContextMessage[], count: number): boolean {
  let remaining = count;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    const originKind = message.origin?.kind;
    if (originKind === 'injection') continue;
    if (originKind === 'compaction_summary') return false;
    if (isRealUserPrompt(message)) {
      remaining -= 1;
      if (remaining === 0) return true;
    }
  }
  return false;
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (
    origin.kind === 'skill_activation' &&
    (origin as { trigger?: string }).trigger === 'user-slash'
  ) {
    return true;
  }
  return false;
}

registerScopedService(
  LifecycleScope.Core,
  ISessionLegacyService,
  SessionLegacyService,
  InstantiationType.Delayed,
  'sessionLegacy',
);
