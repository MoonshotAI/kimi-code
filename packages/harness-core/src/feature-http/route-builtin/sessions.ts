import type { Request, Response } from 'express';

import {
  AgentModelRef,
  ConfigRef,
  MAIN_AGENT_ID,
  ModelCatalogError,
  SessionModelRef,
  SessionSpaceError,
  UndoFeatureError,
  UndoRef,
  useApp,
  useInject,
  type AgentHandle,
  type AppCommands,
  type ContentPart,
  type HistoryMessage,
  type MediaSource,
  type OpenSessionInput,
  type SessionHandle,
  type SessionRecord,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { parseMediaRefUrl } from '#/features/media/ref';

import {
  GOAL_ALREADY_EXISTS,
  GOAL_NOT_FOUND,
  GOAL_NOT_RESUMABLE,
  GOAL_OBJECTIVE_EMPTY,
  GOAL_OBJECTIVE_TOO_LONG,
  GOAL_STATUS_INVALID,
  GoalError,
  GoalRef,
} from '#/features/goal/index';
import { PermissionRef, type PermissionMode } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import { TokenCountingRef } from '#/features/tokenCounting/index';
import { TowerRef, towerEnterFailureMessage } from '#/features/tower/index';
import { UsageRef } from '#/features/usage/index';
import {
  getWorkspaceEntry,
  resolveWorkspaceId,
  sessionWorkspaceId,
  withSessionWorkspace,
  WorkspaceRef,
} from '#/features/workspaces/index';

import { useHttpRoute } from '../feature';
import { useSessionAction, useSessionActionRoutes } from '../route/session-action';
import { ErrorCode, param, readAgentId, requestId, sendErr, sendFacadeErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';
import {
  sessionBusy,
  sessionPendingInteraction,
  sessionStatusView,
  type SessionPendingInteraction,
} from '../route-features/status';

export interface SessionUsageView {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_cost_usd: number;
  readonly context_tokens: number;
  readonly context_limit: number;
  readonly turn_count: number;
}

export interface SessionAgentConfigView {
  readonly model: string;
}

export interface SessionWarningView {
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

export interface SessionView {
  readonly id: string;
  readonly workspace_id?: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly busy: boolean;
  readonly main_turn_active: boolean;
  readonly pending_interaction: SessionPendingInteraction;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  readonly archived?: boolean;
  readonly archived_at?: string;
  readonly metadata?: Record<string, unknown>;
  readonly agent_config: SessionAgentConfigView;
  readonly usage: SessionUsageView;
  readonly permission_rules: readonly unknown[];
  readonly message_count: number;
  readonly agent_ids: string[];
}

export function useSessionRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.list',
    method: 'GET',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const query = readSessionsListQuery(request.query);
      if ('error' in query) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, query.error);
        return;
      }
      const app = useApp();
      let workspaceMatch: ((record: SessionRecord) => boolean) | undefined;
      if (query.workspaceId !== undefined) {
        const workspaces = useInject(WorkspaceRef).value;
        if (workspaces === undefined) {
          workspaceMatch = (record) => sessionWorkspaceId(record) === query.workspaceId;
        } else {
          const state = workspaces.state.value;
          const canonical = resolveWorkspaceId(state, query.workspaceId);
          if (getWorkspaceEntry(state, canonical) === undefined) {
            sendErr(
              request,
              response,
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${query.workspaceId} does not exist`,
            );
            return;
          }
          workspaceMatch = (record) => {
            const id = sessionWorkspaceId(record);
            return id !== undefined && resolveWorkspaceId(state, id) === canonical;
          };
        }
      }
      const sorted = (await app.space.list()).toSorted(compareSessionRecords);
      let window = sorted;
      if (query.beforeId !== undefined || query.afterId !== undefined) {
        const cursor = query.beforeId ?? query.afterId ?? '';
        const position = sorted.findIndex((record) => record.id === cursor);
        if (position === -1) {
          sendOk(request, response, { items: [], has_more: false });
          return;
        }
        window = query.beforeId !== undefined ? sorted.slice(position + 1) : sorted.slice(0, position);
      }
      const archivedOnly = query.archivedOnly === true;
      const includeArchived = archivedOnly || query.includeArchive === true;
      const eligible = window.filter((record) => {
        if (workspaceMatch !== undefined && !workspaceMatch(record)) return false;
        if (archivedOnly ? !isArchived(record) : !includeArchived && isArchived(record)) return false;
        if (query.excludeEmpty === true && isEmptySession(app.get(record.id))) return false;
        return true;
      });
      const busyOf = (record: SessionRecord): boolean => {
        const live = app.get(record.id);
        return live === undefined ? false : sessionBusy(live);
      };
      const project = (record: SessionRecord): SessionView => sessionView(record, app.get(record.id));
      if (query.pageSize === undefined && !archivedOnly) {
        const items = eligible.map(project);
        sendOk(request, response, {
          items: query.busy === undefined ? items : items.filter((item) => item.busy === query.busy),
          has_more: false,
        });
        return;
      }
      const pool =
        archivedOnly && query.busy !== undefined
          ? eligible.filter((record) => busyOf(record) === query.busy)
          : eligible;
      const pageSize = query.pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
      let items = pool.slice(0, pageSize).map(project);
      if (!archivedOnly && query.busy !== undefined) {
        items = items.filter((item) => item.busy === query.busy);
      }
      sendOk(request, response, { items, has_more: pool.length > pageSize });
    },
  });

  useHttpRoute({
    id: 'sessions.create',
    method: 'POST',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const agentConfig = readAgentConfig(request.body);
      if (typeof agentConfig === 'string') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, agentConfig);
        return;
      }
      const app = useApp();
      try {
        const session = await app.open(readSessionInput(request.body));
        if (agentConfig !== undefined && !(await applyAgentConfig(session, agentConfig, request, response))) {
          return;
        }
        const record = await app.space.get(session.sessionId);
        sendOk(request, response, sessionView(record ?? { id: session.sessionId }, session));
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      await sendSessionRecord(request, response, useApp(), sessionId);
    },
  });

  useHttpRoute({
    id: 'sessions.profile.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/profile`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      await sendSessionRecord(request, response, useApp(), sessionId);
    },
  });

  useHttpRoute({
    id: 'sessions.profile.post',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/profile`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const profile = readProfileInput(request.body);
      if (typeof profile === 'string') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, profile);
        return;
      }
      const agentConfig = readAgentConfig(request.body);
      if (typeof agentConfig === 'string') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, agentConfig);
        return;
      }
      const app = useApp();
      try {
        let record = await app.space.get(sessionId);
        if (record === undefined) {
          throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
        }
        if (profile.title !== undefined || profile.metadata !== undefined) {
          record = await app.updateSession(sessionId, {
            title: profile.title,
            metadata: profile.metadata,
          });
        }
        if (agentConfig !== undefined) {
          const session = await app.open({ sessionId });
          if (!(await applyAgentConfig(session, agentConfig, request, response))) return;
          record = (await app.space.get(sessionId)) ?? record;
        }
        sendOk(request, response, sessionView(record, app.get(sessionId)));
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.warnings',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/warnings`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const config = useInject(ConfigRef).value;
      if ((await useApp().space.get(sessionId)) === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      if (config === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.CONFIG_UNAVAILABLE,
          'config is unavailable (config feature is not installed)',
        );
        return;
      }
      sendOk(request, response, {
        warnings: config.diagnostics().map(
          (diagnostic): SessionWarningView => ({
            code: 'config-diagnostic',
            message: diagnostic.message,
            severity: diagnostic.severity,
          }),
        ),
      });
    },
  });

  useHttpRoute({
    id: 'sessions.patch',
    method: 'PATCH',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const app = useApp();
      try {
        if ((await app.space.get(sessionId)) === undefined) {
          throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
        }
        sendOk(
          request,
          response,
          sessionView(await app.updateSession(sessionId, readSessionInput(request.body)), app.get(sessionId)),
        );
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.delete',
    method: 'DELETE',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const app = useApp();
      try {
        await app.delete(sessionId);
        sendOk(request, response, { deleted: true });
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useSessionActionRoutes(prefix);

  useSessionAction('fork', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      if ((await app.space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      const session = await app.open({ ...readSessionInput(request.body), from: sessionId });
      sendOk(request, response, { id: session.sessionId, agent_ids: session.list() });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('abort', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      agent.abort();
      sendOk(request, response, { aborted: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('pause', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      agent.pause();
      sendOk(request, response, { paused: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('continue', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      agent.continue();
      sendOk(request, response, { continued: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('delete', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      await app.delete(sessionId);
      sendOk(request, response, { deleted: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('update', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      if ((await app.space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      sendOk(
        request,
        response,
        sessionView(await app.updateSession(sessionId, readSessionInput(request.body)), app.get(sessionId)),
      );
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('undo', async ({ sessionId, body, request, response }) => {
    const app = useApp();
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      const undo = agent.resolve(UndoRef);
      if (undo === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_UNDO_UNAVAILABLE,
          'session undo is unavailable (undo feature is not installed)',
        );
        return;
      }
      try {
        await undo.undo(body.count ?? 1);
      } catch (error) {
        if (error instanceof UndoFeatureError) {
          if (error.code === 'invalid-count') {
            sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
            return;
          }
          response.status(200).json({
            code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
            msg: error.message,
            data: undoErrorDetails(error),
            request_id: requestId(request),
          });
          return;
        }
        throw error;
      }
      const history = session.stores.get(agentId)?.getState().history ?? [];
      const status = await sessionStatusView(session);
      if (status === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      sendOk(request, response, {
        messages: pageUndoMessages(sessionId, history, body.pageSize),
        status,
      });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('archive', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const record = await app.space.get(sessionId);
      if (record === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      await app.updateSession(sessionId, {
        metadata: { ...record.metadata, archived: true, archived_at: new Date().toISOString() },
      });
      sendOk(request, response, { archived: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });
}

function readSessionInput(body: unknown): OpenSessionInput {
  const input: {
    sessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  } = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return input;
  }
  const record = body as { [key: string]: unknown };
  if (typeof record['session_id'] === 'string' && record['session_id'].length > 0) {
    input.sessionId = record['session_id'];
  }
  if (typeof record['title'] === 'string') {
    input.title = record['title'];
  }
  if (record['metadata'] !== null && typeof record['metadata'] === 'object' && !Array.isArray(record['metadata'])) {
    input.metadata = record['metadata'] as Record<string, unknown>;
  }
  if (typeof record['workspace_id'] === 'string' && record['workspace_id'].length > 0) {
    input.metadata = withSessionWorkspace(input.metadata, record['workspace_id']);
  }
  return input;
}

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

const FALLBACK_SESSION_TIME = new Date(0).toISOString();

interface SessionsListQuery {
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly pageSize?: number;
  readonly busy?: boolean;
  readonly includeArchive?: boolean;
  readonly excludeEmpty?: boolean;
  readonly archivedOnly?: boolean;
  readonly workspaceId?: string;
}

interface SessionAgentConfigInput {
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly towerMode?: boolean;
  readonly towerBase?: string;
  readonly goalObjective?: string;
  readonly goalControl?: 'pause' | 'resume' | 'cancel';
}

async function sendSessionRecord(
  request: Request,
  response: Response,
  app: AppCommands,
  sessionId: string,
): Promise<void> {
  const record = await app.space.get(sessionId);
  if (record === undefined) {
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return;
  }
  sendOk(request, response, sessionView(record, app.get(record.id)));
}

export function sessionView(record: SessionRecord, live: SessionHandle | undefined): SessionView {
  const archivedAt = record.metadata?.['archived_at'];
  const main = live?.get(MAIN_AGENT_ID);
  return {
    id: record.id,
    title: record.title ?? '',
    workspace_id: sessionWorkspaceId(record),
    created_at: record.createdAt ?? record.updatedAt ?? FALLBACK_SESSION_TIME,
    updated_at: record.updatedAt ?? record.createdAt ?? FALLBACK_SESSION_TIME,
    busy: live === undefined ? false : sessionBusy(live),
    main_turn_active: live?.status().mainTurnActive ?? false,
    pending_interaction: live === undefined ? 'none' : sessionPendingInteraction(live),
    last_turn_reason: live?.status().lastTurnReason,
    archived: record.metadata?.['archived'] === true ? true : undefined,
    archived_at: typeof archivedAt === 'string' ? archivedAt : undefined,
    metadata: record.metadata,
    agent_config: { model: sessionModelOf(record, main) },
    usage: sessionUsageOf(main),
    permission_rules: [],
    message_count: live?.stores.get(MAIN_AGENT_ID)?.getState().history.length ?? 0,
    agent_ids: [...(live?.list() ?? [])],
  };
}

function sessionModelOf(record: SessionRecord, main: AgentHandle | undefined): string {
  const bound = main?.resolve(AgentModelRef)?.current.value.alias;
  if (bound !== undefined && bound !== null) return bound;
  const configured = record.metadata?.['defaultModel'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return main?.model?.spec.name ?? '';
}

function sessionUsageOf(main: AgentHandle | undefined): SessionUsageView {
  const usage = main?.resolve(UsageRef)?.summary.value;
  return {
    input_tokens: usage?.total.inputOther ?? 0,
    output_tokens: usage?.total.output ?? 0,
    cache_read_tokens: usage?.total.inputCacheRead ?? 0,
    cache_creation_tokens: usage?.total.inputCacheCreation ?? 0,
    total_cost_usd: 0,
    context_tokens: main?.resolve(TokenCountingRef)?.statusSize() ?? 0,
    context_limit: main?.model?.spec.maxInputSize ?? main?.model?.spec.maxContextSize ?? 0,
    turn_count: usage === undefined ? 0 : Object.keys(usage.byTurn).length,
  };
}

function compareSessionRecords(a: SessionRecord, b: SessionRecord): number {
  const delta = recordTimeOf(b) - recordTimeOf(a);
  if (delta !== 0) return delta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function recordTimeOf(record: SessionRecord): number {
  const raw = record.updatedAt ?? record.createdAt;
  if (raw === undefined) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isArchived(record: SessionRecord): boolean {
  return record.metadata?.['archived'] === true;
}

function isEmptySession(live: SessionHandle | undefined): boolean {
  if (live === undefined) return false;
  return (live.stores.get(MAIN_AGENT_ID)?.getState().history.length ?? 0) === 0;
}

function readSessionsListQuery(
  query: Record<string, unknown>,
): SessionsListQuery | { readonly error: string } {
  const beforeId = readQueryString(query['before_id']);
  const afterId = readQueryString(query['after_id']);
  if (beforeId === null || afterId === null) {
    return { error: 'before_id and after_id must be non-empty strings' };
  }
  if (beforeId !== undefined && afterId !== undefined) {
    return { error: 'before_id and after_id are mutually exclusive' };
  }
  const pageSize = readQueryPageSize(query['page_size']);
  if (pageSize === null) {
    return { error: 'page_size must be an integer between 1 and 100' };
  }
  const busy = readQueryBoolean(query['busy']);
  const includeArchive = readQueryBoolean(query['include_archive']);
  const excludeEmpty = readQueryBoolean(query['exclude_empty']);
  const archivedOnly = readQueryBoolean(query['archived_only']);
  if (busy === null || includeArchive === null || excludeEmpty === null || archivedOnly === null) {
    return { error: 'busy, include_archive, exclude_empty and archived_only must be booleans' };
  }
  if (archivedOnly === true && includeArchive === true) {
    return { error: 'archived_only and include_archive are mutually exclusive' };
  }
  const workspaceId = readQueryString(query['workspace_id']);
  if (workspaceId === null) {
    return { error: 'workspace_id must be a non-empty string' };
  }
  return {
    beforeId,
    afterId,
    pageSize,
    busy,
    includeArchive,
    excludeEmpty,
    archivedOnly,
    workspaceId,
  };
}

function readQueryString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readQueryBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

function readQueryPageSize(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const size = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(size) && size >= 1 && size <= 100 ? size : null;
}

function readProfileInput(
  body: unknown,
): { title?: string; metadata?: Record<string, unknown> } | string {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const record = body as { [key: string]: unknown };
  const input: { title?: string; metadata?: Record<string, unknown> } = {};
  if (record['title'] !== undefined) {
    if (typeof record['title'] !== 'string' || record['title'].length === 0) {
      return 'title must be a non-empty string';
    }
    input.title = record['title'];
  }
  if (record['metadata'] !== undefined) {
    const metadata = record['metadata'];
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return 'metadata must be an object';
    }
    input.metadata = metadata as Record<string, unknown>;
  }
  return input;
}

function readAgentConfig(body: unknown): SessionAgentConfigInput | string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as { agent_config?: unknown })['agent_config'];
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'agent_config must be an object';
  }
  const record = raw as { [key: string]: unknown };
  const input: {
    model?: string;
    thinking?: string;
    permissionMode?: PermissionMode;
    planMode?: boolean;
    towerMode?: boolean;
    towerBase?: string;
    goalObjective?: string;
    goalControl?: 'pause' | 'resume' | 'cancel';
  } = {};
  if (record['model'] !== undefined) {
    if (typeof record['model'] !== 'string') return 'agent_config.model must be a string';
    input.model = record['model'];
  }
  if (record['system_prompt'] !== undefined && typeof record['system_prompt'] !== 'string') {
    return 'agent_config.system_prompt must be a string';
  }
  if (record['tools'] !== undefined && !isStringArray(record['tools'])) {
    return 'agent_config.tools must be an array of strings';
  }
  if (record['mcp_servers'] !== undefined && !isStringArray(record['mcp_servers'])) {
    return 'agent_config.mcp_servers must be an array of strings';
  }
  if (record['thinking'] !== undefined) {
    if (typeof record['thinking'] !== 'string' || record['thinking'].length === 0) {
      return 'agent_config.thinking must be a non-empty string';
    }
    input.thinking = record['thinking'];
  }
  if (record['permission_mode'] !== undefined) {
    const mode = record['permission_mode'];
    if (mode !== 'manual' && mode !== 'yolo' && mode !== 'auto') {
      return 'agent_config.permission_mode must be one of manual, yolo, auto';
    }
    input.permissionMode = mode;
  }
  if (record['plan_mode'] !== undefined) {
    if (typeof record['plan_mode'] !== 'boolean') return 'agent_config.plan_mode must be a boolean';
    input.planMode = record['plan_mode'];
  }
  if (record['swarm_mode'] !== undefined && typeof record['swarm_mode'] !== 'boolean') {
    return 'agent_config.swarm_mode must be a boolean';
  }
  if (record['tower_mode'] !== undefined) {
    if (typeof record['tower_mode'] !== 'boolean') return 'agent_config.tower_mode must be a boolean';
    input.towerMode = record['tower_mode'];
  }
  if (record['tower_base'] !== undefined) {
    if (typeof record['tower_base'] !== 'string' || record['tower_base'].length === 0) {
      return 'agent_config.tower_base must be a non-empty string';
    }
    input.towerBase = record['tower_base'];
  }
  if (record['goal_objective'] !== undefined) {
    if (typeof record['goal_objective'] !== 'string') {
      return 'agent_config.goal_objective must be a string';
    }
    input.goalObjective = record['goal_objective'];
  }
  if (record['goal_control'] !== undefined) {
    const control = record['goal_control'];
    if (control !== 'pause' && control !== 'resume' && control !== 'cancel') {
      return 'agent_config.goal_control must be one of pause, resume, cancel';
    }
    input.goalControl = control;
  }
  return input;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

async function applyAgentConfig(
  session: SessionHandle,
  config: SessionAgentConfigInput,
  request: Request,
  response: Response,
): Promise<boolean> {
  const main = session.get(MAIN_AGENT_ID) ?? (await session.create({ agentId: MAIN_AGENT_ID }));
  try {
    if (config.model !== undefined && config.model !== '') {
      await session.resolve(SessionModelRef)?.setModel(config.model);
    }
    if (config.thinking !== undefined) {
      await session.resolve(SessionModelRef)?.setThinking(config.thinking);
    }
    if (config.permissionMode !== undefined) {
      await main.resolve(PermissionRef)?.setModeAndBroadcast(config.permissionMode);
    }
    if (config.planMode !== undefined) {
      const plan = main.resolve(PlanRef);
      if (plan !== undefined) {
        const active = (await plan.status()) !== null;
        if (active !== config.planMode) {
          if (config.planMode) await plan.enter();
          else await plan.exit();
        }
      }
    }
    if (config.towerMode !== undefined) {
      const tower = main.resolve(TowerRef);
      if (tower !== undefined) {
        if (config.towerMode) {
          const result = await tower.enter(config.towerBase);
          if (!result.entered) {
            sendErr(request, response, ErrorCode.INTERNAL_ERROR, towerEnterFailureMessage(result));
            return false;
          }
        } else {
          await tower.exit();
        }
      }
    }
    if (config.goalObjective !== undefined) {
      await main.resolve(GoalRef)?.createGoal({ objective: config.goalObjective });
    }
    if (config.goalControl !== undefined) {
      const goal = main.resolve(GoalRef);
      if (goal !== undefined) {
        switch (config.goalControl) {
          case 'pause':
            await goal.pauseGoal({});
            break;
          case 'resume':
            await goal.resumeGoal({ continueIfPaused: true, continueIfBlocked: true });
            break;
          case 'cancel':
            await goal.cancelGoal({});
            break;
        }
      }
    }
  } catch (error) {
    if (sendAgentConfigErr(request, response, error)) return false;
    throw error;
  }
  return true;
}

function sendAgentConfigErr(request: Request, response: Response, error: unknown): boolean {
  if (error instanceof ModelCatalogError) {
    if (error.code === 'model.unknown_alias') {
      sendErr(request, response, ErrorCode.MODEL_NOT_FOUND, error.message);
      return true;
    }
    if (error.code === 'model.invalid_thinking') {
      sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
      return true;
    }
    sendErr(request, response, ErrorCode.CONFIG_UNAVAILABLE, error.message);
    return true;
  }
  if (error instanceof GoalError) {
    const code = goalErrorCodeOf(error.code);
    if (code !== undefined) {
      sendErr(request, response, code, error.message);
      return true;
    }
  }
  return false;
}

function goalErrorCodeOf(code: string): number | undefined {
  switch (code) {
    case GOAL_ALREADY_EXISTS:
      return ErrorCode.GOAL_ALREADY_EXISTS;
    case GOAL_NOT_FOUND:
      return ErrorCode.GOAL_NOT_FOUND;
    case GOAL_STATUS_INVALID:
      return ErrorCode.GOAL_STATUS_INVALID;
    case GOAL_NOT_RESUMABLE:
      return ErrorCode.GOAL_NOT_RESUMABLE;
    case GOAL_OBJECTIVE_EMPTY:
      return ErrorCode.GOAL_OBJECTIVE_EMPTY;
    case GOAL_OBJECTIVE_TOO_LONG:
      return ErrorCode.GOAL_OBJECTIVE_TOO_LONG;
  }
  return undefined;
}

function undoErrorDetails(error: UndoFeatureError): { requested?: number; undoable?: number } | null {
  if (error.requested === undefined && error.undoable === undefined) return null;
  return { requested: error.requested, undoable: error.undoable };
}

interface UndoMessageView {
  readonly id: string;
  readonly session_id: string;
  readonly role: string;
  readonly content: readonly unknown[];
  readonly created_at: string;
  readonly metadata?: { readonly origin: unknown };
}

const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

function pageUndoMessages(
  sessionId: string,
  history: readonly HistoryMessage[],
  requestedPageSize: number | undefined,
): { readonly items: readonly UndoMessageView[]; readonly has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((entry, index) => toWireMessage(sessionId, index, entry));
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

function toWireMessage(sessionId: string, index: number, entry: HistoryMessage): UndoMessageView {
  const origin = (entry.meta as { origin?: unknown } | undefined)?.origin;
  return {
    id: messageIdOf(entry) ?? deriveMessageId(sessionId, index),
    session_id: sessionId,
    role: entry.message.role,
    content: wireContent(entry),
    created_at: createdAtOf(entry, index),
    metadata: origin === undefined ? undefined : { origin },
  };
}

function wireContent(entry: HistoryMessage): unknown[] {
  const message = entry.message;
  const visible = message.content.filter((part) => part.type !== 'think' || part.hidden !== true);
  if (message.role === 'tool') {
    const hasMediaPart = visible.some((part) => part.type !== 'text' && part.type !== 'think');
    const output = hasMediaPart
      ? visible.map((part) => mapContentPart(part))
      : visible.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return [
      {
        type: 'tool_result',
        tool_call_id: message.toolCallId,
        output,
        is_error: (entry.meta as ToolMeta | undefined)?.isError === true ? true : undefined,
      },
    ];
  }
  const base: unknown[] = visible.map((part) => mapContentPart(part));
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) {
      let input: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = call.arguments;
        }
      }
      base.push({ type: 'tool_use', tool_call_id: call.id, tool_name: call.name, input });
    }
  }
  return base;
}

function mapContentPart(part: ContentPart): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return part.encrypted === undefined
        ? { type: 'thinking', thinking: part.think }
        : { type: 'thinking', thinking: part.think, signature: part.encrypted };
    case 'image_url':
      return { type: 'image', source: wireMediaSourceOf(part.source), name: part.name };
    case 'audio_url':
      return { type: 'text', text: `[audio:${mediaUrlTextOf(part.source)}]` };
    case 'video_url':
      return { type: 'video', source: wireMediaSourceOf(part.source), name: part.name };
  }
}

function wireMediaSourceOf(source: MediaSource): unknown {
  switch (source.kind) {
    case 'store': {
      const ref = parseMediaRefUrl(source.ref);
      return ref === undefined
        ? { kind: 'url', url: source.ref }
        : { kind: 'session_media', file_id: ref };
    }
    case 'inline':
      return { kind: 'base64', media_type: source.mimeType, data: source.data };
    case 'url':
      return wireMediaSourceFromUrl(source.url);
    case 'file':
      return { kind: 'file', file_id: source.id };
  }
}

function wireMediaSourceFromUrl(url: string): unknown {
  const ref = parseMediaRefUrl(url);
  if (ref !== undefined) return { kind: 'session_media', file_id: ref };
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  return match === null
    ? { kind: 'url', url }
    : { kind: 'base64', media_type: match[1], data: match[2] };
}

function mediaUrlTextOf(source: MediaSource): string {
  switch (source.kind) {
    case 'store':
      return source.ref;
    case 'url':
      return source.url;
    case 'inline':
      return `data:${source.mimeType};base64,${source.data}`;
    case 'file':
      return source.id;
  }
}

function deriveMessageId(sessionId: string, index: number): string {
  return `msg_${sessionId}_${String(index).padStart(6, '0')}`;
}

function messageIdOf(entry: HistoryMessage): string | undefined {
  const meta = entry.meta as { messageId?: unknown; userMessageId?: unknown } | undefined;
  const raw = meta?.messageId ?? meta?.userMessageId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function createdAtOf(entry: HistoryMessage, index: number): string {
  const raw = (entry.meta as { createdAt?: unknown } | undefined)?.createdAt;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(index).toISOString();
}
