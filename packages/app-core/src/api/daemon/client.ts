
import { buildRestUrl, buildWsUrl } from '../config';
import { noopTracer } from '../../contracts';
import type { ClientIdentity, CredentialStore, Tracer } from '../../contracts';
import type {
  AddProviderInput,
  AppCatalogProvider,
  AppConfig,
  AppHost,
  AppHostConnectFailure,
  AppHostDefinition,
  AppHostTestResult,
  AppModel,
  AppProvider,
  AppProviderDetail,
  AuthResult,
  ImportCatalogProviderInput,
  ImportCatalogProviderResult,
  ImportCustomRegistryInput,
  ImportCustomRegistryResult,
  ProviderRefreshResult,
  AppCapabilityStatus,
  AppCapabilityInstallOptions,
  AppMcpAuthBeginResult,
  AppMcpAuthStatus,
  AppMcpServerLocator,
  AppPluginCapabilities,
  AppPluginMarketplaceEntry,
  AppPluginSummary,
  AppSession,
  AppSessionRatingReport,
  AppSessionRatingOffer,
  SessionContextItemDetail,
  SessionContextItemsResponse,
  SessionContextSummary,
  AppSkill,
  AppSkillAttachment,
  AppSkillActivationOptions,
  AppSshConfigHosts,
  AppProviderCopyResult,
  AppWorkspace,
  ApprovalResponse,
  DeleteProviderResult,
  FsBrowseResult,
  FsEntry,
  InteractionOutcome,
  InteractionRespondResult,
  KimiEventConnection,
  TaskCommandResult,
  KimiEventHandlers,
  KimiWebApi,
  MediaBlobOptions,
  ListSessionIdsInput,
  ListSessionGroupsInput,
  ListSessionsInput,
  ManagedQuotaResult,
  ManagedUserInfoResult,
  OAuthLoginStartResult,
  OAuthRegion,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
  ReadRequestOptions,
  RemoteControlStatus,
  TurnFileHistoryChange,
  TurnFileHistoryContent,
  AgentTurnsQuery,
  UpdateProviderInput,
  UpdateProviderResult,
  SessionIdsPage,
  SessionGroupsPage,
  SessionsPage,
  BatchSessionResponse,
  GitStatusEntry,
  GitStatusQuery,
  GitStatusBatchResult,
  PullRequestBatchResult,
} from '../types';
import type { RcDeviceList } from '../../lib/rcDevicesApi';
import { DaemonHttpClient, FORK_TIMEOUT_MS, type RestQuery } from './http';
import { FileTooLargeError, isDaemonApiError } from '../errors';

const HOST_READ_MAX_BYTES = 10_485_760;

const OAUTH_REGION_PROBE_TIMEOUT_MS = 5_000;

const AGENT_TURNS_TIMEOUT_MS = 2 * 60_000;

const VALIDATION_FAILED_CODE = 40001;
import {
  toAppAgentState,
  toAppCapabilityStatus,
  toAppCatalogProvider,
  toAppConfig,
  toAppEvent,
  toAppInteractionEvent,
  toAppFsEntry,
  toAppGoal,
  toAppMcpAuthBeginResult,
  toAppMcpAuthStatus,
  toAppModel,
  toAppPluginCapabilities,
  toAppPluginMarketplaceEntry,
  toAppPluginSummary,
  toAppProvider,
  toAppSession,
  toSessionTask,
  toWireApprovalResponse,
  toAppSessionRatingOffer,
  toWireMcpServerLocator,
  toWireMessageContent,
  toWirePromptSubmission,
  toWireQuestionResponse,
  toWireSessionRatingReport,
  toAppWorkspace,
  toAppHost,
  wireEventSessionId,
} from './mappers';
import type {
  WireAuthResult,
  WireCapabilityStatus,
  WireCatalogProvider,
  WireConfig,
  WireCreateProviderModel,
  WireCreateProviderRequest,
  WireEvent,
  WireHost,
  WireHostDefinition,
  WireHostTestResult,
  WireSshConfigHosts,
  WireFileMeta,
  WireFsBrowseResult,
  WireFsEntry,
  WireFsHomeResult,
  WireFsMkdirResult,
  WireImportCatalogProviderRequest,
  WireImportCatalogProviderResult,
  WireImportCustomRegistryRequest,
  WireImportCustomRegistryResult,
  WireMcpAuthBeginResult,
  WireMcpAuthStatus,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WireOAuthRegionResult,
  WirePage,
  WirePluginCapabilities,
  WirePluginMarketplaceEntry,
  WirePluginSummary,
  WirePromptSubmitResult,
  WirePromptSteerResult,
  WireProvider,
  WireProviderDetail,
  WireProviderRefreshResult,
  WireSession,
  WireSessionCancelResult,
  WireSessionWarning,
  WireSessionWarningsResponse,
  WireUpdateProviderRequest,
  WireUpdateProviderResult,
  WireSessionIdsPage,
  WireSessionGroupsPage,
  WireSessionsPage,
  WireBatchSessionResponse,
  WireWorkspace,
  WireLogoutResult,
  WireSessionRatingResult,
} from './wire';
import { DaemonEventSocket } from './ws';
import type { ConversationTurnsPage } from '../../conversation/types';

function safeExportFileName(contentDisposition: string | undefined, fallback: string): string {
  if (contentDisposition === undefined) return fallback;
  let candidate: string | undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  if (encoded !== undefined) {
    try {
      candidate = decodeURIComponent(encoded.replaceAll(/^"|"$/g, ''));
    } catch {
      return fallback;
    }
  } else {
    candidate =
      /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition)?.[1] ??
      /filename\s*=\s*([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  }
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.length > 200 ||
    candidate === '.' ||
    candidate === '..' ||
    /[\u0000-\u001F\u007F/\\]/.test(candidate) ||
    !candidate.toLowerCase().endsWith('.zip')
  ) {
    return fallback;
  }
  return candidate;
}

function errorTraceMetadata(err: unknown): Record<string, string | number | undefined> {
  if (typeof err !== 'object' || err === null) return { errorName: typeof err };
  const value = err as {
    name?: unknown;
    code?: unknown;
    requestId?: unknown;
    phase?: unknown;
    status?: unknown;
  };
  return {
    errorName: typeof value.name === 'string' ? value.name : 'Error',
    errorCode: typeof value.code === 'number' ? value.code : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    phase: typeof value.phase === 'string' ? value.phase : undefined,
    httpStatus: typeof value.status === 'number' ? value.status : undefined,
  };
}

interface WireHealth {
  status: 'ok';
  uptime_sec: number;
}

interface WireMeta {
  kimi_agent_protocol_version?: string;
  server_version: string;
  server_id: string;
  started_at: string;
  home_dir: string;
  capabilities: Record<string, boolean>;
  open_in_apps?: string[];
  dangerous_bypass_auth?: boolean;
  experimental_flags?: Record<string, boolean>;
  web_title?: string;
}

interface WireAbortResult {
  aborted: boolean;
}

interface WireInteractionRespondResult {
  outcome: InteractionOutcome;
  ended_at: string;
}

interface WireSkillDescriptor {
  name: string;
  description: string;
  path: string;
  source: string;
  workspace_dir?: string;
  type?: string;
  disable_model_invocation?: boolean;
  scopes?: string[];
}

interface WireArchiveResult {
  archived: true;
}

interface WireDeleteResult {
  deleted: true;
}

interface WireListDirectoryResult {
  items: WireFsEntry[];
  children_by_path?: Record<string, WireFsEntry[]>;
  truncated: boolean;
}

interface WireReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  truncated: boolean;
  etag: string;
  mime: string;
  language_id?: string;
  line_count?: number;
  is_binary: boolean;
}

interface WireSearchFilesResult {
  items: Array<{
    path: string;
    name: string;
    kind: 'file' | 'directory' | 'symlink';
    score: number;
    match_positions: number[];
  }>;
  truncated: boolean;
}

interface WireGrepFilesResult {
  files: Array<{
    path: string;
    matches: Array<{
      line: number;
      col: number;
      text: string;
      before: string[];
      after: string[];
    }>;
  }>;
  files_scanned: number;
  truncated: boolean;
  elapsed_ms: number;
}

interface WireGitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest?: { number: number; state: string; url: string } | null;
}

interface WireDiffResult {
  path: string;
  diff: string;
  truncated?: boolean;
}

export interface DaemonKimiWebApiOptions {
  origin: string;
  identity: ClientIdentity;
  tracer?: Tracer;
  credentialStore?: CredentialStore;
  includeHosts?: boolean;
}

export class DaemonKimiWebApi implements KimiWebApi {
  private readonly http: DaemonHttpClient;
  private readonly tracer: Tracer;

  constructor(private readonly opts: DaemonKimiWebApiOptions) {
    this.tracer = opts.tracer ?? noopTracer;
    this.http = new DaemonHttpClient({
      origin: opts.origin,
      identity: opts.identity,
      tracer: this.tracer,
      credentialStore: opts.credentialStore,
    });
  }

  dispose(): void {
    this.http.dispose();
  }

  async getHealth(): Promise<{ status: 'ok'; uptimeSec: number }> {
    const data = await this.http.get<Partial<WireHealth>>('/healthz');
    return { status: 'ok', uptimeSec: data.uptime_sec ?? 0 };
  }

  async getMeta(): Promise<{
    protocolVersion: string;
    serverVersion: string;
    serverId: string;
    startedAt: string;
    homeDir: string;
    capabilities: Record<string, boolean>;
    openInApps: string[];
    dangerousBypassAuth: boolean;
    experimentalFlags: Record<string, boolean>;
    backend: 'v1' | 'v2';
    webTitle: string;
  }> {
    const data = await this.http.get<WireMeta>('/meta');
    return {
      protocolVersion: data.kimi_agent_protocol_version ?? '',
      serverVersion: data.server_version,
      serverId: data.server_id,
      startedAt: data.started_at,
      homeDir: data.home_dir,
      capabilities: data.capabilities,
      openInApps: Array.isArray(data.open_in_apps) ? data.open_in_apps : [],
      dangerousBypassAuth: data.dangerous_bypass_auth === true,
      experimentalFlags: data.experimental_flags ?? {},
      backend: 'v2',
      webTitle: data.web_title ?? '',
    };
  }

  async getRemoteControlStatus(): Promise<RemoteControlStatus> {
    return this.http.get<RemoteControlStatus>('/remote-control');
  }

  async setRemoteControlEnabled(enabled: boolean): Promise<RemoteControlStatus> {
    return this.http.post<RemoteControlStatus>('/remote-control', { enabled });
  }

  async listRemoteControlDevices(): Promise<RcDeviceList> {
    return this.http.get<RcDeviceList>('/remote-control/devices');
  }

  async renameRemoteControlDevice(deviceId: string, alias: string): Promise<void> {
    await this.http.patch<{ ok: true }>(
      `/remote-control/devices/${encodeURIComponent(deviceId)}`,
      { alias },
    );
  }

  async deactivateRemoteControlDevice(deviceId: string): Promise<void> {
    await this.http.post<{ ok: true }>(
      `/remote-control/devices/${encodeURIComponent(deviceId)}/deactivate`,
      {},
    );
  }

  async deleteRemoteControlDevice(deviceId: string): Promise<void> {
    await this.http.delete<{ ok: true }>(
      `/remote-control/devices/${encodeURIComponent(deviceId)}`,
    );
  }

  async listSessions(
    input?: ListSessionsInput,
    options?: ReadRequestOptions,
  ): Promise<SessionsPage> {
    const query: RestQuery = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      page_token: input?.pageToken,
      page: input?.page,
      busy: input?.busy,
      activity: input?.activities,
      workspace_id: input?.workspaceIds ?? input?.workspaceId,
      archived: input?.archived === undefined ? undefined : String(input.archived),
      has_prompt: input?.hasPrompt,
      updated_after: input?.updatedAfter,
      updated_before: input?.updatedBefore,
      query: input?.query,
      sort: input?.sort,
      include: input?.include,
      hosts: input?.localOnly === true ? undefined : this.hostsQuery(),
    };
    const data = await this.http.get<WireSessionsPage>('/sessions', query, options);
    return {
      items: data.items.map(toAppSession),
      hasMore: data.has_more,
      nextPageToken: data.next_page_token ?? null,
      total: data.total ?? data.items.length,
      unavailableHosts: data.unavailable_hosts,
    };
  }

  async listSessionIds(input?: ListSessionIdsInput): Promise<SessionIdsPage> {
    const query: RestQuery = {
      sort: input?.sort,
      page_size: input?.pageSize,
      page_token: input?.pageToken,
      page: input?.page,
      updated_after: input?.updatedAfter,
      updated_before: input?.updatedBefore,
      archived: input?.archived === undefined ? undefined : String(input.archived),
      has_prompt: input?.hasPrompt,
      fields: 'id,archived',
      workspace_id: input?.workspaceIds,
      busy: input?.busy,
      activity: input?.activities,
      hosts: this.hostsQuery(),
    };
    const data = await this.http.get<WireSessionIdsPage>('/sessions', query);
    return {
      items: data.items,
      hasMore: data.has_more,
      nextPageToken: data.next_page_token ?? null,
      total: data.total,
      unavailableHosts: data.unavailable_hosts,
    };
  }

  async listSessionGroups(
    input?: ListSessionGroupsInput,
    options?: ReadRequestOptions,
  ): Promise<SessionGroupsPage> {
    const query: RestQuery = {
      view: 'by_workspace',
      group_page_size: input?.groupPageSize,
      has_prompt: input?.hasPrompt,
      sort: input?.sort,
      include: input?.include,
      page_size: input?.pageSize,
      page_token: input?.pageToken,
      page: input?.page,
      archived: input?.archived === undefined ? undefined : String(input.archived),
      workspace_id: input?.workspaceIds,
      busy: input?.busy,
      activity: input?.activities,
      hosts: input?.localOnly === true ? undefined : this.hostsQuery(),
    };
    const data = await this.http.get<WireSessionGroupsPage>('/sessions', query, options);
    return {
      groups: data.groups.map((group) => ({
        workspaceId: group.workspace_id,
        sessions: group.sessions.map(toAppSession),
        total: group.total,
        hostId: group.host_id,
      })),
      hasMore: data.has_more,
      nextPageToken: data.next_page_token ?? null,
      total: data.total,
      unavailableHosts: data.unavailable_hosts,
    };
  }

  async createSession(input: {
    title?: string;
    cwd?: string;
    model?: string;
    workspaceId?: string;
    planMode?: boolean;
  }): Promise<AppSession> {
    const body: Record<string, unknown> = {
      metadata: input.cwd !== undefined ? { cwd: input.cwd } : {},
    };
    if (input.workspaceId !== undefined) body['workspace_id'] = input.workspaceId;
    if (input.title !== undefined) body['title'] = input.title;
    const agentConfig: Record<string, unknown> = {};
    if (input.model !== undefined) agentConfig['model'] = input.model;
    if (input.planMode !== undefined) agentConfig['plan_mode'] = input.planMode;
    if (Object.keys(agentConfig).length > 0) body['agent_config'] = agentConfig;
    const data = await this.http.post<WireSession>('/sessions', body);
    return toAppSession(data);
  }

  async getSession(sessionId: string, options?: ReadRequestOptions): Promise<AppSession> {
    const data = await this.http.get<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      options,
    );
    return toAppSession(data);
  }

  async findSession(sessionId: string): Promise<AppSession> {
    const data = await this.http.get<WireSession>(`/sessions/${encodeURIComponent(sessionId)}`, { hosts: 'include' });
    return toAppSession(data);
  }

  async updateSession(
    sessionId: string,
    input: {
      title?: string;
      cwd?: string;
      model?: string;
      permissionMode?: string;
      planMode?: boolean;
      swarmMode?: boolean;
      towerMode?: boolean;
      towerBase?: string;
      goalObjective?: string;
      goalControl?: 'pause' | 'resume' | 'cancel' | 'edit';
      thinking?: string;
    },
  ): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body['title'] = input.title;
    if (input.cwd !== undefined) body['metadata'] = { cwd: input.cwd };
    const agentConfig: Record<string, unknown> = {};
    if (input.model !== undefined) agentConfig['model'] = input.model;
    if (input.permissionMode !== undefined) agentConfig['permission_mode'] = input.permissionMode;
    if (input.planMode !== undefined) agentConfig['plan_mode'] = input.planMode;
    if (input.swarmMode !== undefined) agentConfig['swarm_mode'] = input.swarmMode;
    if (input.towerMode !== undefined) agentConfig['tower_mode'] = input.towerMode;
    if (input.towerBase !== undefined) agentConfig['tower_base'] = input.towerBase;
    if (input.goalObjective !== undefined) agentConfig['goal_objective'] = input.goalObjective;
    if (input.goalControl !== undefined) agentConfig['goal_control'] = input.goalControl;
    if (input.thinking !== undefined) agentConfig['thinking'] = input.thinking;
    if (Object.keys(agentConfig).length > 0) body['agent_config'] = agentConfig;
    const data = await this.http.post<{ session: WireSession }>(
      `/sessions/${encodeURIComponent(sessionId)}/profile`,
      body,
    );
    return toAppSession(data.session);
  }

  async evaluateSessionRating(sessionId: string, turnId: string): Promise<AppSessionRatingOffer | null> {
    const data = await this.http.post<WireSessionRatingResult>(
      `/sessions/${encodeURIComponent(sessionId)}/rating`,
      { op: 'evaluate', turn_id: turnId },
    );
    return toAppSessionRatingOffer(data);
  }

  async reportSessionRating(sessionId: string, report: AppSessionRatingReport): Promise<void> {
    await this.http.post<null>(
      `/sessions/${encodeURIComponent(sessionId)}/rating`,
      toWireSessionRatingReport(report),
    );
  }

  async getTurnFileChanges(
    sessionId: string,
    turnNumber: number,
    options?: ReadRequestOptions,
  ): Promise<TurnFileHistoryChange[] | 'unrecorded'> {
    const data = await this.http.get<{
      changes?: TurnFileHistoryChange[];
      recorded?: boolean;
    }>(
      `/sessions/${encodeURIComponent(sessionId)}/file-history/changes`,
      { turn_number: turnNumber },
      { ...options, background: options?.background ?? true },
    );
    if (data.recorded === false) return 'unrecorded';
    return data.changes ?? [];
  }

  async getTurnFileContent(
    sessionId: string,
    turnNumber: number,
    path: string,
    phase?: 'start' | 'end',
  ): Promise<TurnFileHistoryContent | null> {
    const data = await this.http.get<{ content?: TurnFileHistoryContent | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/file-history/content`,
      { turn_number: turnNumber, path, phase },
    );
    return data.content ?? null;
  }

  async getSessionWarnings(sessionId: string, options?: ReadRequestOptions): Promise<WireSessionWarning[]> {
    const data = await this.http.get<WireSessionWarningsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/warnings`,
      undefined,
      { ...options, background: options?.background ?? true },
    );
    return data.warnings ?? [];
  }

  async archiveSession(sessionId: string): Promise<{ archived: true }> {
    const data = await this.http.post<WireArchiveResult>(
      `/sessions/${encodeURIComponent(sessionId)}:archive`,
      {},
    );
    return data;
  }

  async restoreSession(sessionId: string): Promise<AppSession> {
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}:restore`,
      {},
    );
    return toAppSession(data);
  }

  async reloadSession(sessionId: string): Promise<AppSession> {
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}:reload`,
      {},
    );
    return toAppSession(data);
  }

  async takeoverSessionLock(sessionId: string): Promise<void> {
    await this.http.post<{ taken_over: true }>(
      `/sessions/${encodeURIComponent(sessionId)}:takeover`,
      {},
    );
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    const data = await this.http.post<WireDeleteResult>(
      `/sessions/${encodeURIComponent(sessionId)}:delete`,
      {},
    );
    return data;
  }

  async archiveSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.http.post<WireBatchSessionResponse>('/sessions:archive', { ids });
  }

  async restoreSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.http.post<WireBatchSessionResponse>('/sessions:restore', { ids });
  }

  async getAgentTurns(
    sessionId: string,
    agentId: string,
    input?: AgentTurnsQuery,
    options?: ReadRequestOptions,
  ): Promise<ConversationTurnsPage> {
    const data = await this.http.get<ConversationTurnsPage>(
      `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/turns`,
      { before_ordinal: input?.beforeOrdinal, page_size: input?.pageSize },
      { timeoutMs: AGENT_TURNS_TIMEOUT_MS, ...options },
    );
    return { turns: data.turns, has_more: data.has_more };
  }

  async exportSession(
    sessionId: string,
    webLog?: string,
    options?: { desktop?: boolean },
  ): Promise<{ blob: Blob; fileName: string }> {
    const webLogBytes = webLog === undefined ? 0 : new TextEncoder().encode(webLog).byteLength;
    const webLogEntries = webLog === undefined || webLog.length === 0 ? 0 : webLog.split('\n').length;
    const path = `/sessions/${encodeURIComponent(sessionId)}/export`;
    const traceBody = { web_log_bytes: webLogBytes, web_log_entries: webLogEntries };
    const withDesktop = options?.desktop === true;
    let result: { blob: Blob; contentDisposition?: string };
    try {
      result = await this.http.postZip(
        path,
        { web_log: webLog, ...(withDesktop ? { desktop: true } : {}) },
        traceBody,
      );
    } catch (error) {
      if (withDesktop && isDaemonApiError(error) && error.code === VALIDATION_FAILED_CODE) {
        result = await this.http.postZip(path, { web_log: webLog }, traceBody);
      } else {
        throw error;
      }
    }
    const fallback = `${sessionId}.zip`;
    return {
      blob: result.blob,
      fileName: safeExportFileName(result.contentDisposition, fallback),
    };
  }

  async submitPrompt(
    sessionId: string,
    input: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    return this.submitPromptToPath(sessionId, 'prompts', input);
  }

  async steerPrompt(
    sessionId: string,
    input: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    return this.submitPromptToPath(sessionId, 'steer', input);
  }

  private async submitPromptToPath(
    sessionId: string,
    path: 'prompts' | 'steer',
    input: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    const startedAt = Date.now();
    this.tracer.traceKeyEvent?.('prompt:start', {
      sessionId,
      contentCount: input.content.length,
      mediaCount: input.content.filter((part) =>
        part.type === 'image' || part.type === 'video' || part.type === 'file'
      ).length,
    });
    try {
      const data = await this.http.post<WirePromptSubmitResult>(
        `/sessions/${encodeURIComponent(sessionId)}/${path}`,
        toWirePromptSubmission(input),
      );
      this.tracer.traceKeyEvent?.('prompt:accepted', {
        sessionId,
        promptId: data.prompt_id,
        status: data.status,
        durationMs: Date.now() - startedAt,
      });
      return {
        promptId: data.prompt_id,
        userMessageId: data.user_message_id,
        origin: data.origin,
        status: data.status,
      };
    } catch (error) {
      this.tracer.traceKeyEvent?.('prompt:failed', {
        sessionId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...errorTraceMetadata(error),
      });
      throw error;
    }
  }

  async steerPrompts(
    sessionId: string,
    promptIds: string[],
  ): Promise<{ steered: boolean; promptIds: string[] }> {
    const data = await this.http.post<WirePromptSteerResult>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
      { prompt_ids: promptIds },
    );
    return { steered: data.steered, promptIds: data.prompt_ids };
  }

  async abortPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<{ aborted: boolean }> {
    const data = await this.http.post<WireAbortResult>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      undefined,
      { allowCodes: [40903] },
    );
    return { aborted: data.aborted };
  }

  async cancelSession(
    sessionId: string,
    options?: { agentId?: string; includeBackground?: boolean },
  ): Promise<{ cancelled: boolean }> {
    const body: Record<string, unknown> = {};
    if (options?.agentId !== undefined) body['agent_id'] = options.agentId;
    if (options?.includeBackground !== undefined) body['include_background'] = options.includeBackground;
    const data = await this.http.post<WireSessionCancelResult>(
      `/sessions/${encodeURIComponent(sessionId)}:cancel`,
      body,
    );
    return { cancelled: data.cancelled };
  }

  async compactSession(sessionId: string, instruction?: string): Promise<void> {
    await this.http.post(
      `/sessions/${encodeURIComponent(sessionId)}:compact`,
      instruction ? { instruction } : {},
    );
  }

  async getSessionContextSummary(
    sessionId: string,
    agentId?: string,
    options?: ReadRequestOptions,
  ): Promise<SessionContextSummary> {
    return this.http.get<SessionContextSummary>(
      `/sessions/${encodeURIComponent(sessionId)}/context/summary`,
      { agent_id: agentId },
      options,
    );
  }

  async getSessionContextItems(
    sessionId: string,
    query?: { agentId?: string; role?: string; roles?: readonly string[]; offset?: number; limit?: number },
    options?: ReadRequestOptions,
  ): Promise<SessionContextItemsResponse> {
    return this.http.get<SessionContextItemsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/context/items`,
      {
        agent_id: query?.agentId,
        role: query?.roles?.length ? query.roles : query?.role,
        offset: query?.offset !== undefined ? String(query.offset) : undefined,
        limit: query?.limit !== undefined ? String(query.limit) : undefined,
      },
      options,
    );
  }

  async getSessionContextItem(
    sessionId: string,
    itemId: string,
    agentId?: string,
  ): Promise<SessionContextItemDetail> {
    return this.http.get<SessionContextItemDetail>(
      `/sessions/${encodeURIComponent(sessionId)}/context/items/${encodeURIComponent(itemId)}`,
      { agent_id: agentId },
    );
  }

  async undoSession(sessionId: string, turnId: string, agentId?: string): Promise<readonly string[]> {
    const data = await this.http.post<{ removed_turn_ids: string[] }>(
      `/sessions/${encodeURIComponent(sessionId)}:undo`,
      { turn_id: turnId, agent_id: agentId },
    );
    return data.removed_turn_ids;
  }

  async generateSessionTitle(
    sessionId: string,
    input?: { force?: boolean; source?: 'user_prompts' | 'first_turn' | 'digest' },
  ): Promise<string | null> {
    try {
      const body: Record<string, unknown> = {};
      if (input?.force === true) body['force'] = true;
      if (input?.source !== undefined) body['source'] = input.source;
      const data = await this.http.post<{ title?: string } | null>(
        `/sessions/${encodeURIComponent(sessionId)}/title/generate`,
        body,
      );
      return typeof data?.title === 'string' && data.title.length > 0 ? data.title : null;
    } catch {
      return null;
    }
  }

  async forkSession(sessionId: string, input?: { title?: string; turnIndex?: number }): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input?.title !== undefined) body['title'] = input.title;
    if (input?.turnIndex !== undefined) body['turn_index'] = input.turnIndex;
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}:fork`,
      body,
      { timeoutMs: FORK_TIMEOUT_MS },
    );
    return toAppSession(data);
  }

  async startBtw(sessionId: string): Promise<{ agentId: string }> {
    const data = await this.http.post<{ agent_id: string }>(
      `/sessions/${encodeURIComponent(sessionId)}:btw`,
      {},
    );
    return { agentId: data.agent_id };
  }

  respondApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<InteractionRespondResult> {
    return this.respondInteraction(sessionId, approvalId, {
      kind: 'approval',
      ...toWireApprovalResponse(response),
    });
  }

  respondQuestion(
    sessionId: string,
    questionId: string,
    response: QuestionResponse,
  ): Promise<InteractionRespondResult> {
    return this.respondInteraction(sessionId, questionId, {
      kind: 'question',
      ...toWireQuestionResponse(response),
    });
  }

  dismissQuestion(sessionId: string, questionId: string): Promise<InteractionRespondResult> {
    return this.respondInteraction(sessionId, questionId, { kind: 'question', dismissed: true });
  }

  private async respondInteraction(
    sessionId: string,
    interactionId: string,
    body: Record<string, unknown>,
  ): Promise<InteractionRespondResult> {
    const data = await this.http.post<WireInteractionRespondResult>(
      `/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`,
      body,
    );
    return { outcome: data.outcome, endedAt: data.ended_at };
  }

  async listSkills(sessionId: string, options?: ReadRequestOptions): Promise<AppSkill[]> {
    const data = await this.http.get<{ skills: WireSkillDescriptor[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/skills`,
      undefined,
      { ...options, background: options?.background ?? true },
    );
    return this.toAppSkills(data.skills);
  }

  async listSkillsForWorkspace(workspaceId: string, options?: ReadRequestOptions): Promise<AppSkill[]> {
    const data = await this.http.get<{ skills: WireSkillDescriptor[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
      undefined,
      { ...options, background: options?.background ?? true },
    );
    return this.toAppSkills(data.skills);
  }

  private toAppSkills(skills: WireSkillDescriptor[] | undefined): AppSkill[] {
    const uiMode = this.opts.identity.clientUiMode;
    return (skills ?? [])
      .filter((s) => s.scopes === undefined || s.scopes.includes(uiMode))
      .map((s) => ({
        name: s.name,
        description: s.description,
        path: s.path,
        source: s.source,
        workspaceDir: s.workspace_dir,
      }));
  }

  async activateSkill(
    sessionId: string,
    skillName: string,
    args?: string,
    attachments?: AppSkillAttachment[],
    options?: AppSkillActivationOptions,
  ): Promise<{ activated: true; skillName: string }> {
    const body: Record<string, unknown> = {};
    if (options?.skillPath !== undefined) body['path'] = options.skillPath;
    if (options?.metadata !== undefined) body['metadata'] = options.metadata;
    if (options?.promptId !== undefined) body['prompt_id'] = options.promptId;
    if (args !== undefined && args.length > 0) body['args'] = args;
    if (attachments !== undefined && attachments.length > 0) {
      body['attachments'] = attachments.map(toWireMessageContent);
    }
    const data = await this.http.post<{ activated: true; skill_name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillName)}:activate`,
      body,
    );
    return { activated: data.activated, skillName: data.skill_name };
  }

  async listCapabilities(): Promise<AppCapabilityStatus[]> {
    const data = await this.http.get<{ capabilities: WireCapabilityStatus[] }>('/capabilities');
    return (data.capabilities ?? []).map(toAppCapabilityStatus);
  }

  async getCapability(capabilityId: string): Promise<AppCapabilityStatus> {
    const data = await this.http.get<WireCapabilityStatus>(
      `/capabilities/${encodeURIComponent(capabilityId)}`,
    );
    return toAppCapabilityStatus(data);
  }

  async installCapability(capabilityId: string, options: AppCapabilityInstallOptions = {}): Promise<AppCapabilityStatus> {
    const body: Record<string, unknown> = {};
    if (options.stopRunningProcesses !== undefined) {
      body['stop_running_processes'] = options.stopRunningProcesses;
    }
    const data = await this.http.post<WireCapabilityStatus>(
      `/capabilities/${encodeURIComponent(capabilityId)}:install`,
      body,
    );
    return toAppCapabilityStatus(data);
  }

  async listPlugins(): Promise<AppPluginSummary[]> {
    const data = await this.http.get<{ plugins: WirePluginSummary[] }>('/plugins');
    return (data.plugins ?? []).map(toAppPluginSummary);
  }

  async getPluginInfo(pluginId: string, locale?: string): Promise<AppPluginCapabilities> {
    const data = await this.http.get<WirePluginCapabilities>(`/plugins/${encodeURIComponent(pluginId)}`, { locale });
    return toAppPluginCapabilities(data);
  }

  async previewPlugin(input: {
    marketplaceId: string;
    expectedVersion?: string;
    expectedSha256?: string;
    locale?: string;
  }): Promise<AppPluginCapabilities> {
    const body: Record<string, unknown> = { marketplace_id: input.marketplaceId };
    if (input.expectedVersion !== undefined) body['expected_version'] = input.expectedVersion;
    if (input.expectedSha256 !== undefined) body['expected_sha256'] = input.expectedSha256;
    if (input.locale !== undefined) body['locale'] = input.locale;
    const data = await this.http.post<WirePluginCapabilities>('/plugins/preview', body, { timeoutMs: 180_000 });
    return toAppPluginCapabilities(data);
  }

  async listPluginMarketplace(): Promise<AppPluginMarketplaceEntry[]> {
    const data = await this.http.get<{ entries: WirePluginMarketplaceEntry[] }>(
      '/plugins/marketplace',
    );
    return (data.entries ?? []).map(toAppPluginMarketplaceEntry);
  }

  async installPlugin(input: string | { marketplaceId: string; expectedVersion?: string; expectedSha256?: string }): Promise<AppPluginSummary> {
    const body: Record<string, unknown> =
      typeof input === 'string'
        ? { source: input }
        : {
            marketplace_id: input.marketplaceId,
            ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
            ...(input.expectedSha256 === undefined ? {} : { expected_sha256: input.expectedSha256 }),
          };
    const data = await this.http.post<WirePluginSummary>(
      '/plugins',
      body,
      { timeoutMs: 180_000 },
    );
    return toAppPluginSummary(data);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: true }> {
    return this.http.post<{ ok: true }>(
      `/plugins/${encodeURIComponent(pluginId)}:${enabled ? 'enable' : 'disable'}`,
      {},
    );
  }

  async removePlugin(pluginId: string): Promise<{ ok: true }> {
    return this.http.post<{ ok: true }>(
      `/plugins/${encodeURIComponent(pluginId)}:remove`,
      {},
    );
  }

  async getMcpAuthStatuses(options?: { cwd?: string }): Promise<AppMcpAuthStatus[]> {
    const data = await this.http.get<WireMcpAuthStatus[]>('/mcp/auth-statuses', {
      verify: 'false',
      cwd: options?.cwd,
    });
    return data.map(toAppMcpAuthStatus);
  }

  async beginMcpAuth(
    locator: AppMcpServerLocator,
    options?: { cwd?: string },
  ): Promise<AppMcpAuthBeginResult> {
    const query = options?.cwd === undefined ? '' : `?cwd=${encodeURIComponent(options.cwd)}`;
    const data = await this.http.post<WireMcpAuthBeginResult>(
      `/mcp/auth:begin${query}`,
      toWireMcpServerLocator(locator),
    );
    return toAppMcpAuthBeginResult(data);
  }

  async completeMcpAuth(input: {
    flowId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<null> {
    return this.http.post<null>(
      '/mcp/auth:complete',
      { flow_id: input.flowId, timeout_ms: input.timeoutMs },
      { signal: input.signal, timeoutMs: input.timeoutMs },
    );
  }

  async cancelMcpAuth(flowId: string): Promise<null> {
    return this.http.post<null>('/mcp/auth:cancel', { flow_id: flowId });
  }

  async resetMcpAuth(locator: AppMcpServerLocator, options?: { cwd?: string }): Promise<null> {
    const query = options?.cwd === undefined ? '' : `?cwd=${encodeURIComponent(options.cwd)}`;
    return this.http.post<null>(`/mcp/auth:reset${query}`, toWireMcpServerLocator(locator));
  }

  async listDirectory(
    sessionId: string,
    input: { path?: string; depth?: number; includeGitStatus?: boolean; showHidden?: boolean; allowIgnoredGlobs?: string[]; allowExternalSymlinks?: boolean },
  ): Promise<{
    items: FsEntry[];
    childrenByPath?: Record<string, FsEntry[]>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = {};
    if (input.path !== undefined) body['path'] = input.path;
    if (input.depth !== undefined) body['depth'] = input.depth;
    if (input.includeGitStatus !== undefined) body['include_git_status'] = input.includeGitStatus;
    if (input.showHidden !== undefined) body['show_hidden'] = input.showHidden;
    if (input.allowIgnoredGlobs !== undefined) body['allow_ignored_globs'] = input.allowIgnoredGlobs;
    if (input.allowExternalSymlinks !== undefined) {
      body['allow_external_symlinks'] = input.allowExternalSymlinks;
    }
    const data = await this.http.post<WireListDirectoryResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:list`,
      body,
    );
    const childrenByPath = data.children_by_path
      ? Object.fromEntries(
          Object.entries(data.children_by_path).map(([k, v]) => [k, v.map(toAppFsEntry)]),
        )
      : undefined;
    return {
      items: data.items.map(toAppFsEntry),
      childrenByPath,
      truncated: data.truncated,
    };
  }

  async listWorkspaceDirectory(
    workspace: string,
    input: { path?: string; depth?: number; showHidden?: boolean; allowIgnoredGlobs?: string[]; allowExternalSymlinks?: boolean },
  ): Promise<{
    items: FsEntry[];
    childrenByPath?: Record<string, FsEntry[]>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { workspace };
    if (input.path !== undefined) body['path'] = input.path;
    if (input.depth !== undefined) body['depth'] = input.depth;
    if (input.showHidden !== undefined) body['show_hidden'] = input.showHidden;
    if (input.allowIgnoredGlobs !== undefined) body['allow_ignored_globs'] = input.allowIgnoredGlobs;
    if (input.allowExternalSymlinks !== undefined) {
      body['allow_external_symlinks'] = input.allowExternalSymlinks;
    }
    const data = await this.http.post<WireListDirectoryResult>('/workspace/fs:list', body);
    const childrenByPath = data.children_by_path
      ? Object.fromEntries(
          Object.entries(data.children_by_path).map(([k, v]) => [k, v.map(toAppFsEntry)]),
        )
      : undefined;
    return {
      items: data.items.map(toAppFsEntry),
      childrenByPath,
      truncated: data.truncated,
    };
  }

  async readFile(
    sessionId: string,
    input: { path: string; offset?: number; length?: number; allowExternalSymlinks?: boolean },
  ): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    size: number;
    truncated: boolean;
    etag: string;
    mime: string;
    languageId?: string;
    lineCount?: number;
    isBinary: boolean;
  }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.offset !== undefined) body['offset'] = input.offset;
    if (input.length !== undefined) body['length'] = input.length;
    if (input.allowExternalSymlinks !== undefined) {
      body['allow_external_symlinks'] = input.allowExternalSymlinks;
    }
    const data = await this.http.post<WireReadFileResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:read`,
      body,
    );
    return {
      path: data.path,
      content: data.content,
      encoding: data.encoding,
      size: data.size,
      truncated: data.truncated,
      etag: data.etag,
      mime: data.mime,
      languageId: data.language_id,
      lineCount: data.line_count,
      isBinary: data.is_binary,
    };
  }

  async searchFiles(
    workspace: string,
    input: { query: string; limit?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<{
    items: Array<{
      path: string;
      name: string;
      kind: 'file' | 'directory' | 'symlink';
      score: number;
      matchPositions: number[];
    }>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { workspace, query: input.query };
    if (input.limit !== undefined) body['limit'] = input.limit;
    const data = await this.http.post<WireSearchFilesResult>(
      `/workspace/fs:search`,
      body,
      { signal: opts?.signal },
    );
    return {
      items: data.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        score: item.score,
        matchPositions: item.match_positions,
      })),
      truncated: data.truncated,
    };
  }

  async suggestFiles(
    workspace: string,
    input: { query: string; limit?: number; showHidden?: boolean },
    opts?: { signal?: AbortSignal },
  ): Promise<{
    items: Array<{
      path: string;
      name: string;
      kind: 'file' | 'directory' | 'symlink';
      score: number;
      matchPositions: number[];
    }>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { workspace, query: input.query };
    if (input.limit !== undefined) body['limit'] = input.limit;
    if (input.showHidden !== undefined) body['show_hidden'] = input.showHidden;
    const data = await this.http.post<WireSearchFilesResult>(
      `/workspace/fs:suggest`,
      body,
      { signal: opts?.signal },
    );
    return {
      items: data.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        score: item.score,
        matchPositions: item.match_positions,
      })),
      truncated: data.truncated,
    };
  }

  async suggestFilesAtRoots(
    roots: readonly string[],
    input: { query: string; limit?: number; showHidden?: boolean },
    opts?: { signal?: AbortSignal },
  ): Promise<{
    items: Array<{
      path: string;
      name: string;
      kind: 'file' | 'directory' | 'symlink';
      score: number;
      matchPositions: number[];
    }>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { roots: [...roots], query: input.query };
    if (input.limit !== undefined) body['limit'] = input.limit;
    if (input.showHidden !== undefined) body['show_hidden'] = input.showHidden;
    const data = await this.http.post<WireSearchFilesResult>(
      `/fs:suggest`,
      body,
      { signal: opts?.signal },
    );
    return {
      items: data.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        score: item.score,
        matchPositions: item.match_positions,
      })),
      truncated: data.truncated,
    };
  }

  async grepFiles(
    sessionId: string,
    input: { pattern: string; regex?: boolean; caseSensitive?: boolean },
  ): Promise<{
    files: Array<{
      path: string;
      matches: Array<{
        line: number;
        col: number;
        text: string;
        before: string[];
        after: string[];
      }>;
    }>;
    filesScanned: number;
    truncated: boolean;
    elapsedMs: number;
  }> {
    const body: Record<string, unknown> = { pattern: input.pattern };
    if (input.regex !== undefined) body['regex'] = input.regex;
    if (input.caseSensitive !== undefined) body['case_sensitive'] = input.caseSensitive;
    const data = await this.http.post<WireGrepFilesResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:grep`,
      body,
    );
    return {
      files: data.files,
      filesScanned: data.files_scanned,
      truncated: data.truncated,
      elapsedMs: data.elapsed_ms,
    };
  }

  async getGitStatus(
    sessionId: string,
    input?: GitStatusQuery,
    options?: ReadRequestOptions,
  ): Promise<GitStatusEntry> {
    const body: Record<string, unknown> = {};
    if (input?.root !== undefined) body['root'] = input.root;
    if (input?.paths !== undefined) body['paths'] = input.paths;
    if (input?.includePullRequest !== undefined) body['include_pull_request'] = input.includePullRequest;
    const data = await this.http.post<WireGitStatusResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:git_status`,
      body,
      { ...options, background: options?.background ?? true },
    );
    return {
      branch: data.branch,
      ahead: data.ahead,
      behind: data.behind,
      entries: data.entries,
      additions: data.additions,
      deletions: data.deletions,
      pullRequest: data.pullRequest ?? null,
    };
  }

  async getPullRequest(
    sessionId: string,
    input?: { root?: string },
    options?: ReadRequestOptions,
  ): Promise<GitStatusEntry['pullRequest']> {
    const body: Record<string, unknown> = {};
    if (input?.root !== undefined) body['root'] = input.root;
    return this.http.post<GitStatusEntry['pullRequest']>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:pull_request`,
      body,
      { ...options, background: options?.background ?? true },
    );
  }

  async getGitStatusBatch(
    sessionId: string,
    input: { roots: string[]; includePullRequest?: boolean },
    options?: ReadRequestOptions,
  ): Promise<GitStatusBatchResult> {
    const body: Record<string, unknown> = { roots: input.roots };
    if (input.includePullRequest !== undefined) body['include_pull_request'] = input.includePullRequest;
    return this.http.post<GitStatusBatchResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:git_status:batch`,
      body,
      { ...options, background: options?.background ?? true },
    );
  }

  async getPullRequestBatch(
    sessionId: string,
    input: { roots: string[] },
    options?: ReadRequestOptions,
  ): Promise<PullRequestBatchResult> {
    return this.http.post<PullRequestBatchResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:pull_request:batch`,
      { roots: input.roots },
      { ...options, background: options?.background ?? true },
    );
  }

  async getFileDiff(
    sessionId: string,
    path: string,
    input?: { root?: string },
    options?: ReadRequestOptions,
  ): Promise<{ path: string; diff: string; truncated: boolean }> {
    const body: Record<string, unknown> = { path };
    if (input?.root !== undefined) body['root'] = input.root;
    const data = await this.http.post<WireDiffResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
      body,
      { ...options, background: options?.background ?? true },
    );
    return { path: data.path, diff: data.diff, truncated: data.truncated ?? false };
  }

  getFileDownloadUrl(
    sessionId: string,
    path: string,
    opts?: { allowExternalSymlinks?: boolean },
  ): string {
    const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    const query = opts?.allowExternalSymlinks === true ? '?allow_external_symlinks=true' : '';
    return buildRestUrl(
      this.opts.origin,
      `/sessions/${encodeURIComponent(sessionId)}/fs/${encodedPath}:download${query}`,
    );
  }

  async downloadSessionFile(
    sessionId: string,
    path: string,
    opts?: { prefixBytes?: number; allowExternalSymlinks?: boolean },
  ): Promise<Blob> {
    const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    const query = opts?.allowExternalSymlinks === true ? '?allow_external_symlinks=true' : '';
    return this.http.getBlob(
      `/sessions/${encodeURIComponent(sessionId)}/fs/${encodedPath}:download${query}`,
      undefined,
      opts?.prefixBytes !== undefined ? { prefixBytes: opts.prefixBytes } : undefined,
    );
  }

  async openFile(
    sessionId: string,
    input: { path: string; line?: number },
  ): Promise<{ opened: true }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.line !== undefined) body['line'] = input.line;
    return this.http.post<{ opened: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:open`,
      body,
    );
  }

  async revealFile(
    sessionId: string,
    input: { path: string },
  ): Promise<{ revealed: true }> {
    return this.http.post<{ revealed: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:reveal`,
      { path: input.path },
    );
  }

  async openInApp(
    sessionId: string,
    appId: string,
    path: string,
    line?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { app_id: appId, path };
    if (line !== undefined) body['line'] = line;
    await this.http.post<{ opened: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:open-in`,
      body,
    );
  }

  private hostsQuery(): 'include' | undefined {
    return this.opts.includeHosts === true ? 'include' : undefined;
  }

  async listWorkspaces(): Promise<AppWorkspace[]> {
    try {
      const data = await this.http.get<WirePage<WireWorkspace>>('/workspaces', { hosts: this.hostsQuery() });
      return (data.items ?? []).map(toAppWorkspace);
    } catch {
      return [];
    }
  }

  async addWorkspace(input: {
    root: string;
    name?: string;
    additionalDirs?: string[];
    idempotencyKey: string;
  }): Promise<AppWorkspace> {
    const body: Record<string, unknown> = { root: input.root, idempotency_key: input.idempotencyKey };
    if (input.name !== undefined) body['name'] = input.name;
    if (input.additionalDirs !== undefined) body['additional_dirs'] = input.additionalDirs;
    const data = await this.http.post<WireWorkspace>('/workspaces', body);
    return toAppWorkspace(data);
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.http.delete(`/workspaces/${encodeURIComponent(id)}`);
  }

  async updateWorkspace(
    id: string,
    input: { name?: string; additionalDirs?: string[] },
  ): Promise<AppWorkspace> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body['name'] = input.name;
    if (input.additionalDirs !== undefined) body['additional_dirs'] = input.additionalDirs;
    const data = await this.http.patch<WireWorkspace>(
      `/workspaces/${encodeURIComponent(id)}`,
      body,
    );
    return toAppWorkspace(data);
  }

  async setWorkspacePrimary(id: string, path: string): Promise<AppWorkspace> {
    const data = await this.http.post<WireWorkspace>(
      `/workspaces/${encodeURIComponent(id)}/primary`,
      { path },
    );
    return toAppWorkspace(data);
  }

  async getWorkspaceProjectConfigDirs(root: string): Promise<string[]> {
    const data = await this.http.get<{ additional_dirs: string[] }>(
      '/workspaces/project-config-dirs',
      { root },
    );
    return data.additional_dirs;
  }

  async getWorkspaceTrust(workspaceId: string, options?: ReadRequestOptions): Promise<{ trusted: boolean }> {
    return this.http.get<{ trusted: boolean }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/trust`,
      undefined,
      { ...options, background: options?.background ?? true },
    );
  }

  async trustWorkspace(workspaceId: string): Promise<{ trusted: boolean }> {
    return this.http.post<{ trusted: boolean }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/trust`,
      {},
    );
  }

  async browseFs(path: string | undefined, signal?: AbortSignal): Promise<FsBrowseResult> {
    const data = await this.http.get<WireFsBrowseResult>('/fs:browse', { path }, { signal });
    return {
      path: data.path,
      parent: data.parent,
      entries: (data.entries ?? []).map((e) => ({
        name: e.name,
        path: e.path,
        isDir: e.is_dir,
      })),
    };
  }

  async listHosts(): Promise<AppHost[]> {
    const data = await this.http.get<{ hosts: WireHost[] }>('/hosts');
    return data.hosts.map(toAppHost);
  }

  async putHost(id: string, definition: AppHostDefinition): Promise<void> {
    await this.http.put(`/hosts/${encodeURIComponent(id)}`, toWireHostDefinition(definition));
  }

  async deleteHost(id: string): Promise<void> {
    await this.http.delete(`/hosts/${encodeURIComponent(id)}`);
  }

  async connectHost(id: string): Promise<AppHost> {
    return toAppHost(await this.http.post<WireHost>('/hosts:connect', { id }, { timeoutMs: 120_000 }));
  }

  async testHost(definition: AppHostDefinition, opts?: { signal?: AbortSignal }): Promise<AppHostTestResult> {
    const data = await this.http.post<WireHostTestResult>('/hosts:test', toWireHostDefinition(definition), {
      signal: opts?.signal,
      timeoutMs: 60_000,
    });
    return {
      connected: data.connected,
      remoteVersion: data.remote_version,
      connectError: data.connect_error,
      connectFailure: data.connect_failure as AppHostConnectFailure | undefined,
    };
  }

  async listHostSshConfig(): Promise<AppSshConfigHosts> {
    const data = await this.http.get<WireSshConfigHosts>('/hosts:ssh-hosts');
    return {
      configPath: data.config_path,
      exists: data.exists,
      hosts: data.hosts.map((host) => ({ alias: host.alias, hostName: host.host_name, user: host.user, port: host.port })),
    };
  }

  async copyProvidersToHost(id: string): Promise<AppProviderCopyResult> {
    return this.http.post<AppProviderCopyResult>('/hosts:copy-providers', { id }, { timeoutMs: 180_000 });
  }

  async getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
    try {
      const data = await this.http.get<WireFsHomeResult>('/fs:home');
      return { home: data.home, recentRoots: data.recent_roots ?? [] };
    } catch {
      return { home: '', recentRoots: [] };
    }
  }

  async mkdirFs(path: string): Promise<{ path: string }> {
    const data = await this.http.post<WireFsMkdirResult>('/fs:mkdir', { path });
    return { path: data.path };
  }

  async listModels(): Promise<AppModel[]> {
    const data = await this.http.get<{ items: WireModel[] }>('/models');
    return data.items.map(toAppModel);
  }

  async listProviders(): Promise<AppProvider[]> {
    const data = await this.http.get<{ items: WireProvider[] }>('/providers');
    return data.items.map(toAppProvider);
  }

  async getProvider(id: string): Promise<AppProviderDetail> {
    const wire = await this.http.get<WireProviderDetail>(`/providers/${encodeURIComponent(id)}`);
    const app = toAppProvider(wire);
    return wire.api_key !== undefined ? { ...app, apiKey: wire.api_key } : app;
  }

  async addProvider(input: AddProviderInput): Promise<AppProvider> {
    const body: WireCreateProviderRequest = {
      id: input.id ?? '',
      type: input.type,
      models: (input.models ?? []).map((model) => {
        const wire: WireCreateProviderModel = {
          model: model.model,
          max_context_size: model.maxContextSize,
        };
        if (model.displayName !== undefined) wire.display_name = model.displayName;
        if (model.capabilities !== undefined) wire.capabilities = model.capabilities;
        if (model.maxOutputSize !== undefined) wire.max_output_size = model.maxOutputSize;
        if (model.supportEfforts !== undefined) wire.support_efforts = model.supportEfforts;
        if (model.adaptiveThinking !== undefined) wire.adaptive_thinking = model.adaptiveThinking;
        return wire;
      }),
    };
    if (input.apiKey !== undefined) body.api_key = input.apiKey;
    if (input.baseUrl !== undefined) body.base_url = input.baseUrl;
    if (input.defaultModel !== undefined) body.default_model = input.defaultModel;
    const data = await this.http.post<WireProvider>('/providers', body);
    return toAppProvider(data);
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<UpdateProviderResult> {
    const body: WireUpdateProviderRequest = {
      type: input.type,
      models: (input.models ?? []).map((model) => {
        const wire: WireCreateProviderModel = {
          model: model.model,
          max_context_size: model.maxContextSize,
        };
        if (model.displayName !== undefined) wire.display_name = model.displayName;
        if (model.capabilities !== undefined) wire.capabilities = model.capabilities;
        if (model.maxOutputSize !== undefined) wire.max_output_size = model.maxOutputSize;
        if (model.supportEfforts !== undefined) wire.support_efforts = model.supportEfforts;
        if (model.adaptiveThinking !== undefined) wire.adaptive_thinking = model.adaptiveThinking;
        return wire;
      }),
    };
    if (input.newId !== undefined) body.new_id = input.newId;
    if (input.apiKey !== undefined) body.api_key = input.apiKey;
    if (input.baseUrl !== undefined) body.base_url = input.baseUrl;
    if (input.defaultModel !== undefined) body.default_model = input.defaultModel;
    const data = await this.http.put<WireUpdateProviderResult>(
      `/providers/${encodeURIComponent(id)}`,
      body,
    );
    return { provider: toAppProvider(data.provider) };
  }

  async deleteProvider(id: string): Promise<DeleteProviderResult> {
    await this.http.delete<null>(`/providers/${encodeURIComponent(id)}`);
    return { deleted: id };
  }

  async listCatalogProviders(): Promise<AppCatalogProvider[]> {
    const data = await this.http.get<{ items: WireCatalogProvider[] }>('/catalog/providers');
    return data.items.map(toAppCatalogProvider);
  }

  async getCatalogProvider(catalogId: string): Promise<AppCatalogProvider> {
    const wire = await this.http.get<WireCatalogProvider>(
      `/catalog/providers/${encodeURIComponent(catalogId)}`,
    );
    return toAppCatalogProvider(wire);
  }

  async importCatalogProvider(
    input: ImportCatalogProviderInput,
  ): Promise<ImportCatalogProviderResult> {
    const body: WireImportCatalogProviderRequest = { catalog_id: input.catalogId };
    if (input.apiKey !== undefined) body.api_key = input.apiKey;
    if (input.baseUrl !== undefined) body.base_url = input.baseUrl;
    if (input.id !== undefined) body.id = input.id;
    const data = await this.http.post<WireImportCatalogProviderResult>(
      '/providers:import_catalog',
      body,
    );
    return { provider: toAppProvider(data.provider), modelsImported: data.models_imported };
  }

  async importCustomRegistry(
    input: ImportCustomRegistryInput,
  ): Promise<ImportCustomRegistryResult> {
    const body: WireImportCustomRegistryRequest = { url: input.url };
    if (input.apiKey !== undefined) body.api_key = input.apiKey;
    const data = await this.http.post<WireImportCustomRegistryResult>(
      '/providers:import_registry',
      body,
    );
    return {
      providers: data.providers.map(toAppProvider),
      modelsImported: data.models_imported,
    };
  }

  async refreshProvider(id: string): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>(
      `/providers/${encodeURIComponent(id)}:refresh`,
    );
    return toProviderRefreshResult(data);
  }

  async refreshAllProviders(): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>('/providers:refresh');
    return toProviderRefreshResult(data);
  }

  async refreshOAuthProviderModels(): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>('/providers:refresh_oauth');
    return toProviderRefreshResult(data);
  }

  async getConfig(): Promise<AppConfig> {
    const data = await this.http.get<WireConfig>('/config');
    return toAppConfig(data);
  }

  async setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const wirePatch: Record<string, unknown> = {};
    const keyMap: Record<keyof AppConfig, string> = {
      providers: 'providers',
      defaultProvider: 'default_provider',
      defaultModel: 'default_model',
      secondaryModel: 'secondary_model',
      models: 'models',
      thinking: 'thinking',
      planMode: 'plan_mode',
      yolo: 'yolo',
      defaultPermissionMode: 'default_permission_mode',
      defaultPlanMode: 'default_plan_mode',
      autoSessionTitle: 'auto_session_title',
      permission: 'permission',
      hooks: 'hooks',
      services: 'services',
      mergeAllAvailableSkills: 'merge_all_available_skills',
      extraSkillDirs: 'extra_skill_dirs',
      loopControl: 'loop_control',
      background: 'background',
      experimental: 'experimental',
      telemetry: 'telemetry',
      disableFeedbackSurvey: 'disable_feedback_survey',
      raw: 'raw',
    };
    for (const [key, value] of Object.entries(patch)) {
      const wireKey = keyMap[key as keyof AppConfig];
      if (wireKey !== undefined) {
        wirePatch[wireKey] = value;
      }
    }
    const data = await this.http.post<WireConfig>('/config', wirePatch);
    return toAppConfig(data);
  }

  async getAuth(): Promise<AuthResult> {
    const data = await this.http.get<WireAuthResult>('/auth');
    return {
      modelsReady: data.models_ready,
      providersCount: data.providers_count,
      managedProvider: data.managed_provider
        ? { status: data.managed_provider.status }
        : null,
    };
  }

  async startOAuthLogin(region?: OAuthRegion): Promise<OAuthLoginStartResult> {
    let data: WireOAuthLoginStartResult;
    try {
      data = await this.http.post<WireOAuthLoginStartResult>(
        '/oauth/login',
        region === undefined ? {} : { region },
      );
    } catch (error) {
      if (region !== undefined && isDaemonApiError(error) && error.code === VALIDATION_FAILED_CODE) {
        data = await this.http.post<WireOAuthLoginStartResult>('/oauth/login', {});
      } else {
        throw error;
      }
    }
    if (data.status === 'authenticated') {
      return {
        flowId: data.flow_id,
        provider: data.provider,
        status: 'authenticated',
      };
    }
    return {
      flowId: data.flow_id,
      provider: data.provider,
      status: 'pending',
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      userCode: data.user_code,
      expiresIn: data.expires_in,
      interval: data.interval,
      expiresAt: data.expires_at,
    };
  }

  async pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null> {
    const data = await this.http.get<WireOAuthLoginPollResult | null>('/oauth/login');
    if (!data) return null;
    return {
      flowId: data.flow_id,
      status: data.status,
      resolvedAt: data.resolved_at,
      errorMessage: data.error_message,
    };
  }

  async cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }> {
    const data = await this.http.delete<WireOAuthCancelResult>('/oauth/login');
    return { cancelled: data.cancelled, status: data.status };
  }

  async logout(): Promise<{ loggedOut: boolean }> {
    const data = await this.http.post<WireLogoutResult>('/oauth/logout', {});
    return { loggedOut: data.logged_out };
  }

  async getUsage(): Promise<ManagedQuotaResult> {
    return this.http.get<ManagedQuotaResult>('/oauth/usage');
  }

  async getUserInfo(): Promise<ManagedUserInfoResult> {
    return this.http.get<ManagedUserInfoResult>('/oauth/userinfo');
  }

  async getOAuthRegion(): Promise<OAuthRegion | null> {
    try {
      const data = await Promise.race([
        this.http.get<WireOAuthRegionResult>('/oauth/region'),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('oauth region probe timed out')),
            OAUTH_REGION_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return data.region === 'mainland-cn' || data.region === 'global' ? data.region : null;
    } catch {
      return null;
    }
  }

  async getClientConfig(name: string, options?: ReadRequestOptions): Promise<unknown> {
    const data = await this.http.get<{ name: string; config: unknown }>(
      `/client-configs/${encodeURIComponent(name)}`,
      undefined,
      { ...options, background: options?.background ?? true },
    );
    return data.config ?? null;
  }

  async uploadFile(input: { file: Blob; name?: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }): Promise<{ id: string; name: string; mediaType: string; size: number }> {
    const formData = new FormData();
    formData.append('file', input.file, input.name ?? (input.file instanceof File ? input.file.name : 'upload'));
    if (input.name !== undefined) {
      formData.append('name', input.name);
    }
    const data = await this.http.postForm<WireFileMeta>('/files', formData, {
      onUploadProgress: input.onProgress,
      signal: input.signal,
    });
    return {
      id: data.id,
      name: data.name,
      mediaType: data.media_type,
      size: data.size,
    };
  }

  getFileUrl(fileId: string): string {
    return buildRestUrl(this.opts.origin, `/files/${encodeURIComponent(fileId)}`);
  }

  async getFileBlob(fileId: string, options?: MediaBlobOptions): Promise<Blob> {
    return this.http.getBlob(`/files/${encodeURIComponent(fileId)}`, undefined, options);
  }

  getSessionMediaUrl(sessionId: string, fileId: string): string {
    return buildRestUrl(
      this.opts.origin,
      `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
    );
  }

  async getSessionMediaBlob(sessionId: string, fileId: string, options?: MediaBlobOptions): Promise<Blob> {
    return this.http.getBlob(
      `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
      undefined,
      options,
    );
  }

  async readHostFileContent(path: string): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mime: string;
    isBinary: boolean;
    size: number;
  }> {
    const blob = await this.http.getBlob('/fs:content', { path }, { maxBytes: HOST_READ_MAX_BYTES });
    if (blob.size > HOST_READ_MAX_BYTES) {
      throw new FileTooLargeError({ size: blob.size, limit: HOST_READ_MAX_BYTES });
    }
    const rawMime = blob.type;
    const isBinary = !isTextLikeMime(rawMime);
    const mime = rawMime || (isBinary ? 'application/octet-stream' : 'text/plain');
    if (isBinary) {
      const content = await blobToBase64(blob);
      return { path, content, encoding: 'base64', mime, isBinary: true, size: blob.size };
    }
    const content = await blob.text();
    return { path, content, encoding: 'utf-8', mime, isBinary: false, size: blob.size };
  }

  async downloadHostFile(path: string, opts?: { prefixBytes?: number }): Promise<Blob> {
    return this.http.getBlob(
      '/fs:content',
      { path },
      opts?.prefixBytes !== undefined ? { prefixBytes: opts.prefixBytes } : undefined,
    );
  }

  connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const wsUrl = buildWsUrl(this.opts.origin);

    const socket = new DaemonEventSocket({
      wsUrl,
      tracer: this.tracer,
      credentialStore: this.opts.credentialStore,
      handlers: {
      onWireEvent: (wireEvent: WireEvent) => {
        handlers.onEvent(toAppEvent(wireEvent), { sessionId: wireEventSessionId(wireEvent) });
      },

      onInteraction: (interaction) => {
        handlers.onEvent(toAppInteractionEvent(interaction), { sessionId: interaction.session_id });
      },

      onInteractionsReset: (sessionId) => {
        handlers.onEvent({ type: 'interactionsReset', sessionId }, { sessionId });
      },

      onConnectionState: (connected: boolean) => {
        handlers.onConnectionChange(connected);
      },

      onError: (code: number, msg: string, fatal: boolean) => {
        handlers.onError(code, msg, fatal);
      },

      onConversation: (sessionId, agentId, frame) => {
        handlers.onConversation?.(sessionId, agentId, frame);
      },

      onConversationFailed: (sessionId, code, msg) => {
        handlers.onConversationFailed?.(sessionId, code, msg);
      },

      onTaskList: (list) => {
        handlers.onTaskList?.(list.session_id, list.agent_id, list.tasks.map(toSessionTask));
      },

      onTask: (sessionId, agentId, task) => {
        handlers.onTask?.(sessionId, agentId, toSessionTask(task));
      },

      onAgentFeedFrame: (frame) => {
        const { session_id: sessionId, agent_id: agentId } = frame;
        switch (frame.type) {
          case 'agent':
            handlers.onAgentState?.(sessionId, agentId, toAppAgentState(frame));
            return;
          case 'context':
            handlers.onAgentUsage?.(sessionId, agentId, {
              contextTokens: frame.context_tokens,
              contextLimit: frame.max_context_tokens,
            });
            return;
          case 'goal':
            handlers.onAgentGoal?.(sessionId, agentId, toAppGoal(frame.goal));
            return;
          case 'todo':
            handlers.onAgentTodos?.(sessionId, agentId, frame.items);
            return;
        }
      },

      onTaskOutput: (sessionId, agentId, taskId, offset, text) => {
        handlers.onTaskOutput?.(sessionId, agentId, taskId, offset, text);
      },

      onTaskOutputFailed: (sessionId, agentId, taskId) => {
        handlers.onTaskOutputFailed?.(sessionId, agentId, taskId);
      },
    }
    });

    socket.connect();

    return {
      subscribeConversation(sessionId: string, agentId: string): void {
        socket.subscribeConversation(sessionId, agentId);
      },
      unsubscribeConversation(sessionId: string, agentIds?: string[]): void {
        socket.unsubscribeConversation(sessionId, agentIds);
      },
      watchTaskOutput(sessionId: string, agentId: string, taskId: string): void {
        socket.watchTaskOutput(sessionId, agentId, taskId);
      },
      unwatchTaskOutput(sessionId: string, agentId: string, taskId: string): void {
        socket.unwatchTaskOutput(sessionId, agentId, taskId);
      },
      stopTask(sessionId: string, agentId: string, taskId: string): Promise<TaskCommandResult> {
        return socket.sendTaskCommand('task.stop', sessionId, agentId, taskId);
      },
      backgroundTask(sessionId: string, agentId: string, taskId: string): Promise<TaskCommandResult> {
        return socket.sendTaskCommand('task.background', sessionId, agentId, taskId);
      },
      health(): { connected: boolean; open: boolean; stale: boolean } {
        return socket.health();
      },
      reconnect(): void {
        socket.reconnect();
      },
      close(): void {
        socket.close();
      },
    };
  }
}

function toProviderRefreshResult(data: WireProviderRefreshResult): ProviderRefreshResult {
  return {
    changed: data.changed.map((item) => ({
      providerId: item.provider_id,
      providerName: item.provider_name,
      added: item.added,
      removed: item.removed,
    })),
    unchanged: data.unchanged,
    failed: data.failed,
  };
}

function isTextLikeMime(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === '' || m === 'text/plain') return true;
  if (m.startsWith('text/')) return true;
  return /(json|xml|javascript|typescript|x-yaml|yaml|svg|x-sh|x-python|markdown|csv|html|css)$/.test(m);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function toWireHostDefinition(definition: AppHostDefinition): WireHostDefinition {
  return {
    host: definition.host,
    identity_file: definition.identityFile,
    remote_bin: definition.remoteBin,
    name: definition.name,
    enabled: definition.enabled,
  };
}
