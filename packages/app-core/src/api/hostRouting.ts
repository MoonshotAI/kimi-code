import type {
  AppEvent,
  AppHost,
  AppSession,
  AppWorkspace,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  BatchSessionResponse,
} from './types';
import type { DaemonKimiWebApi } from './daemon/client';

type Route = 'local' | 'session' | 'localSession' | 'workspace' | 'file' | 'custom';

const ROUTES = {
  dispose: 'custom',
  getHealth: 'local',
  getMeta: 'local',
  getRemoteControlStatus: 'local',
  setRemoteControlEnabled: 'local',
  listRemoteControlDevices: 'local',
  renameRemoteControlDevice: 'local',
  deactivateRemoteControlDevice: 'local',
  deleteRemoteControlDevice: 'local',
  listSessions: 'custom',
  listSessionIds: 'custom',
  listSessionGroups: 'custom',
  createSession: 'custom',
  getSession: 'session',
  updateSession: 'session',
  evaluateSessionRating: 'session',
  reportSessionRating: 'session',
  getTurnFileChanges: 'session',
  getTurnFileContent: 'session',
  getSessionWarnings: 'session',
  getSessionContextSummary: 'session',
  getSessionContextItems: 'session',
  getSessionContextItem: 'session',
  archiveSession: 'session',
  restoreSession: 'session',
  reloadSession: 'session',
  takeoverSessionLock: 'session',
  deleteSession: 'session',
  archiveSessions: 'custom',
  restoreSessions: 'custom',
  getAgentTurns: 'session',
  exportSession: 'session',
  submitPrompt: 'session',
  steerPrompt: 'session',
  steerPrompts: 'session',
  abortPrompt: 'session',
  cancelSession: 'session',
  continueSession: 'session',
  compactSession: 'session',
  undoSession: 'session',
  generateSessionTitle: 'session',
  forkSession: 'session',
  startBtw: 'session',
  closeAgent: 'session',
  respondApproval: 'session',
  respondQuestion: 'session',
  dismissQuestion: 'session',
  listSkills: 'session',
  listSkillsForWorkspace: 'workspace',
  activateSkill: 'session',
  listCapabilities: 'local',
  getCapability: 'local',
  installCapability: 'local',
  listPlugins: 'local',
  getPluginInfo: 'local',
  previewPlugin: 'local',
  listPluginMarketplace: 'local',
  installPlugin: 'local',
  setPluginEnabled: 'local',
  removePlugin: 'local',
  getMcpAuthStatuses: 'local',
  beginMcpAuth: 'local',
  completeMcpAuth: 'local',
  cancelMcpAuth: 'local',
  resetMcpAuth: 'local',
  listDirectory: 'session',
  listWorkspaceDirectory: 'workspace',
  readFile: 'session',
  searchFiles: 'workspace',
  suggestFiles: 'workspace',
  suggestFilesAtRoots: 'local',
  grepFiles: 'session',
  getGitStatus: 'session',
  getPullRequest: 'session',
  getGitStatusBatch: 'session',
  getPullRequestBatch: 'session',
  getFileDiff: 'session',
  getFileDownloadUrl: 'session',
  downloadSessionFile: 'session',
  openFile: 'localSession',
  revealFile: 'localSession',
  openInApp: 'localSession',
  connectEvents: 'custom',
  listWorkspaces: 'custom',
  addWorkspace: 'custom',
  updateWorkspace: 'custom',
  setWorkspacePrimary: 'custom',
  getWorkspaceProjectConfigDirs: 'local',
  deleteWorkspace: 'custom',
  getWorkspaceTrust: 'workspace',
  trustWorkspace: 'workspace',
  browseFs: 'local',
  mkdirFs: 'local',
  listHosts: 'custom',
  putHost: 'local',
  deleteHost: 'local',
  connectHost: 'custom',
  testHost: 'local',
  copyProvidersToHost: 'local',
  listHostSshConfig: 'local',
  getFsHome: 'local',
  listModels: 'local',
  listProviders: 'local',
  getProvider: 'local',
  addProvider: 'local',
  updateProvider: 'local',
  deleteProvider: 'local',
  refreshProvider: 'local',
  refreshAllProviders: 'local',
  refreshOAuthProviderModels: 'local',
  listCatalogProviders: 'local',
  getCatalogProvider: 'local',
  importCatalogProvider: 'local',
  importCustomRegistry: 'local',
  uploadFile: 'custom',
  getFileUrl: 'file',
  getFileBlob: 'file',
  getSessionMediaUrl: 'session',
  getSessionMediaBlob: 'session',
  readHostFileContent: 'local',
  downloadHostFile: 'local',
  getConfig: 'local',
  setConfig: 'local',
  getAuth: 'local',
  startOAuthLogin: 'local',
  pollOAuthLogin: 'local',
  cancelOAuthLogin: 'local',
  logout: 'local',
  getUsage: 'local',
  getUserInfo: 'local',
  getOAuthRegion: 'local',
  getClientConfig: 'local',
} as const satisfies Record<keyof KimiWebApi, Route>;

const IMMEDIATE_CUSTOM: ReadonlySet<string> = new Set(['dispose', 'connectEvents']);

type AnyApi = Record<string, (...args: unknown[]) => unknown>;

interface HostClient {
  readonly api: DaemonKimiWebApi;
  record: AppHost;
}

interface HostTagged {
  id: string;
  host_id?: string;
}

export interface HostRoutingControls {
  deviceApi(hostId: string | undefined): KimiWebApi;
}

function isRoutedMethod(method: string): method is keyof typeof ROUTES {
  return Object.hasOwn(ROUTES, method);
}

export class HostRouter implements HostRoutingControls {
  private readonly hosts = new Map<string, HostClient>();
  private readonly sessionHost = new Map<string, string | null>();
  private readonly onSessionHostChanged = new Set<(sessionId: string, hostId: string | null) => void>();

  private setSessionHost(sessionId: string, hostId: string | null): void {
    const previous = this.sessionHost.get(sessionId);
    this.sessionHost.set(sessionId, hostId);
    if (previous !== hostId) {
      for (const listener of this.onSessionHostChanged) listener(sessionId, hostId);
    }
  }
  private readonly lookups = new Map<string, Promise<AppSession>>();
  private readonly workspaceHost = new Map<string, string>();
  private readonly fileHost = new Map<string, string>();
  private readonly streamSyncs = new Set<() => void>();
  private readonly hostListeners = new Set<(hosts: AppHost[]) => void>();
  private reportedHosts: string | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly local: DaemonKimiWebApi,
    private readonly createHostClient: (hostId: string) => DaemonKimiWebApi,
  ) {}

  createApi(): KimiWebApi & HostRoutingControls {
    return new Proxy({} as KimiWebApi & HostRoutingControls, {
      get: (_target, property) => {
        if (property === 'deviceApi') return this.deviceApi.bind(this);
        if (typeof property !== 'string' || !isRoutedMethod(property)) return undefined;
        return (...args: unknown[]) => this.invoke(property, args);
      },
    });
  }

  deviceApi(hostId: string | undefined): KimiWebApi {
    return hostId === undefined ? this.local : this.clientFor(hostId);
  }

  private invoke(method: keyof typeof ROUTES, args: unknown[]): unknown {
    const route: Route = ROUTES[method];
    if (route !== 'custom') return this.dispatch(method, route, args);
    const custom = (this as unknown as AnyApi)[`route_${method}`]!;
    if (IMMEDIATE_CUSTOM.has(method)) return custom.apply(this, args);
    return this.whenReady().then(() => custom.apply(this, args));
  }

  private whenReady(): Promise<void> {
    this.ready ??= this.refreshHosts().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async refreshHosts(): Promise<void> {
    this.applyHostRecords(await this.local.listHosts());
  }

  private applyHostRecords(records: readonly AppHost[]): void {
    const known = new Set(records.map((record) => record.id));
    const removed = new Set<string>();
    for (const id of this.hosts.keys()) {
      if (known.has(id)) continue;
      removed.add(id);
      this.hosts.get(id)?.api.dispose();
      this.hosts.delete(id);
    }
    if (removed.size > 0) {
      for (const [id, hostId] of this.workspaceHost) {
        if (removed.has(hostId)) this.workspaceHost.delete(id);
      }
      for (const [id, hostId] of this.sessionHost) {
        if (hostId !== null && removed.has(hostId)) this.sessionHost.delete(id);
      }
      for (const [id, hostId] of this.fileHost) {
        if (removed.has(hostId)) this.fileHost.delete(id);
      }
    }
    for (const record of records) {
      const existing = this.hosts.get(record.id);
      if (existing === undefined) this.hosts.set(record.id, { api: this.createHostClient(record.id), record });
      else existing.record = record;
    }
    for (const sync of this.streamSyncs) sync();
    this.reportHosts();
  }

  private reportHosts(): void {
    const hosts = this.hostList();
    const key = JSON.stringify(hosts);
    if (key === this.reportedHosts) return;
    this.reportedHosts = key;
    for (const listener of this.hostListeners) listener(hosts);
  }

  private hostList(): AppHost[] {
    return [...this.hosts.values()].map((host) => host.record);
  }

  private clientFor(hostId: string): DaemonKimiWebApi {
    const host = this.hosts.get(hostId);
    if (host === undefined) throw new Error(`SSH host "${hostId}" is not configured`);
    return host.api;
  }

  private apiFor(hostId: string | undefined): AnyApi {
    return this.deviceApi(hostId) as unknown as AnyApi;
  }

  private dispatch(method: string, route: Exclude<Route, 'custom'>, args: unknown[]): unknown {
    const key = args[0] as string;
    if (route === 'session' || route === 'localSession') {
      const owner = this.sessionHost.get(key);
      if (owner === undefined) return this.dispatchUnknownSession(method, route, args);
      return this.dispatchSession(method, route, args, owner ?? undefined);
    }
    const hostId = route === 'workspace' ? this.workspaceHost.get(key) : route === 'file' ? this.fileHost.get(key) : undefined;
    const api = this.apiFor(hostId);
    return api[method]!.apply(api, args);
  }

  private async dispatchUnknownSession(method: string, route: 'session' | 'localSession', args: unknown[]): Promise<unknown> {
    const sessionId = args[0] as string;
    await this.whenReady();
    if (this.hosts.size === 0) return this.dispatchSession(method, route, args, undefined);
    const session = await this.lookUp(sessionId);
    if (method === 'getSession') return session;
    return this.dispatchSession(method, route, args, session.hostId);
  }

  private lookUp(sessionId: string): Promise<AppSession> {
    const pending = this.lookups.get(sessionId);
    if (pending !== undefined) return pending;
    const lookup = this.local
      .findSession(sessionId)
      .then((session) => {
        this.setSessionHost(session.id, session.hostId ?? null);
        return session;
      })
      .finally(() => {
        this.lookups.delete(sessionId);
      });
    this.lookups.set(sessionId, lookup);
    return lookup;
  }

  private async ownerOf(sessionId: string): Promise<string | undefined> {
    const owner = this.sessionHost.get(sessionId);
    if (owner !== undefined) return owner ?? undefined;
    await this.whenReady();
    if (this.hosts.size === 0) return undefined;
    return this.lookUp(sessionId).then((session) => session.hostId);
  }

  private dispatchSession(method: string, route: 'session' | 'localSession', args: unknown[], hostId: string | undefined): unknown {
    if (route === 'localSession' && hostId !== undefined) {
      return Promise.reject(new Error('This action is not available for projects on a remote host'));
    }
    const api = this.apiFor(hostId);
    const result = api[method]!.apply(api, args);
    if (method === 'forkSession') {
      return (result as Promise<{ id?: string }>).then((session) => {
        if (session.id !== undefined) this.setSessionHost(session.id, hostId ?? null);
        return session;
      });
    }
    return result;
  }

  private rememberSessions(hostId: string | undefined, sessions: readonly AppSession[]): AppSession[] {
    for (const session of sessions) this.setSessionHost(session.id, hostId ?? session.hostId ?? null);
    return hostId === undefined ? [...sessions] : sessions.map((session) => ({ ...session, hostId }));
  }

  private rememberWorkspace(hostId: string | undefined, workspace: AppWorkspace): AppWorkspace {
    if (hostId === undefined) return workspace;
    this.workspaceHost.set(workspace.id, hostId);
    return { ...workspace, hostId };
  }

  private rewriteEvent(hostId: string, event: AppEvent): AppEvent {
    switch (event.type) {
      case 'workspaceCreated':
      case 'workspaceUpdated':
        return { ...event, workspace: this.rememberWorkspace(hostId, event.workspace) };
      case 'workspaceDeleted':
        this.workspaceHost.delete(event.workspaceId);
        return event;
      case 'sessionCreated':
        this.setSessionHost(event.session.id, hostId);
        return event;
      case 'sessionArchived':
      case 'sessionRestored':
      case 'sessionWorkChanged':
      case 'sessionMetaUpdated':
      case 'approvalRequested':
      case 'questionRequested':
      case 'interactionsReset':
        this.setSessionHost(event.sessionId, hostId);
        return event;
      case 'sessionDeleted':
        this.sessionHost.delete(event.sessionId);
        return event;
      default:
        return event;
    }
  }

  private fanOut(handlers: KimiEventHandlers): KimiEventConnection {
    const local = this.local.connectEvents(handlers);
    const remote = new Map<string, KimiEventConnection>();
    const subscriptions = new Map<string, Set<string>>();
    const taskWatches = new Map<string, { sessionId: string; agentId: string; taskId: string }>();
    const connectionFor = (hostId: string | null | undefined): KimiEventConnection | undefined =>
      hostId === undefined || hostId === null ? local : remote.get(hostId);
    const onOwnerChanged = (sessionId: string, hostId: string | null): void => {
      const connection = connectionFor(hostId);
      if (connection === undefined) return;
      const agents = subscriptions.get(sessionId);
      if (agents !== undefined) {
        for (const agentId of agents) connection.subscribeConversation(sessionId, agentId);
      }
      for (const watch of taskWatches.values()) {
        if (watch.sessionId === sessionId) {
          connection.watchTaskOutput(watch.sessionId, watch.agentId, watch.taskId);
        }
      }
    };
    const sync = (): void => {
      for (const [id, connection] of remote) {
        if (this.hosts.get(id)?.record.status === 'ready') continue;
        connection.close();
        remote.delete(id);
      }
      for (const [id, host] of this.hosts) {
        if (host.record.status !== 'ready' || remote.has(id)) continue;
        const connection = host.api.connectEvents(this.hostHandlers(id, handlers));
        remote.set(id, connection);
        for (const [sessionId, agents] of subscriptions) {
          if (this.sessionHost.get(sessionId) !== id) continue;
          for (const agentId of agents) connection.subscribeConversation(sessionId, agentId);
        }
        for (const watch of taskWatches.values()) {
          if (this.sessionHost.get(watch.sessionId) === id) {
            connection.watchTaskOutput(watch.sessionId, watch.agentId, watch.taskId);
          }
        }
      }
    };
    this.streamSyncs.add(sync);
    this.onSessionHostChanged.add(onOwnerChanged);
    sync();
    const forSession = (sessionId: string): KimiEventConnection | undefined =>
      connectionFor(this.sessionHost.get(sessionId));
    const requireForSession = (sessionId: string): KimiEventConnection => forSession(sessionId) ?? local;
    return {
      subscribeConversation: (sessionId, agentId) => {
        let agents = subscriptions.get(sessionId);
        if (agents === undefined) {
          agents = new Set();
          subscriptions.set(sessionId, agents);
        }
        agents.add(agentId);
        forSession(sessionId)?.subscribeConversation(sessionId, agentId);
      },
      unsubscribeConversation: (sessionId, agentIds) => {
        const agents = subscriptions.get(sessionId);
        if (agents !== undefined) {
          if (agentIds === undefined) subscriptions.delete(sessionId);
          else {
            for (const id of agentIds) agents.delete(id);
            if (agents.size === 0) subscriptions.delete(sessionId);
          }
        }
        forSession(sessionId)?.unsubscribeConversation(sessionId, agentIds);
      },
      watchTaskOutput: (sessionId, agentId, taskId) => {
        taskWatches.set(`${sessionId}\0${agentId}\0${taskId}`, { sessionId, agentId, taskId });
        forSession(sessionId)?.watchTaskOutput(sessionId, agentId, taskId);
      },
      unwatchTaskOutput: (sessionId, agentId, taskId) => {
        taskWatches.delete(`${sessionId}\0${agentId}\0${taskId}`);
        forSession(sessionId)?.unwatchTaskOutput(sessionId, agentId, taskId);
      },
      stopTask: (sessionId, agentId, taskId) => requireForSession(sessionId).stopTask(sessionId, agentId, taskId),
      backgroundTask: (sessionId, agentId, taskId) => requireForSession(sessionId).backgroundTask(sessionId, agentId, taskId),
      health: () => local.health(),
      reconnect: () => {
        local.reconnect();
        for (const connection of remote.values()) connection.reconnect();
      },
      close: () => {
        this.streamSyncs.delete(sync);
        this.onSessionHostChanged.delete(onOwnerChanged);
        subscriptions.clear();
        taskWatches.clear();
        local.close();
        for (const connection of remote.values()) connection.close();
        remote.clear();
      },
    };
  }

  private hostHandlers(hostId: string, handlers: KimiEventHandlers): KimiEventHandlers {
    let stale = true;
    return {
      ...handlers,
      onEvent: (event, meta) => {
        handlers.onEvent(this.rewriteEvent(hostId, event), { ...meta, hostId });
      },
      onError: () => {},
      onConnectionChange: (connected) => {
        if (!connected) stale = true;
        else if (stale) {
          stale = false;
          handlers.onConnectionChange(true);
        }
      },
    };
  }

  protected route_dispose(): void {
    this.streamSyncs.clear();
    this.onSessionHostChanged.clear();
    this.hostListeners.clear();
    for (const host of this.hosts.values()) host.api.dispose();
    this.hosts.clear();
    this.local.dispose();
  }

  protected route_connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const report = (hosts: AppHost[]): void => handlers.onEvent({ type: 'hostsChanged', hosts }, { sessionId: '' });
    this.hostListeners.add(report);
    if (this.reportedHosts !== undefined) report(this.hostList());
    void this.whenReady().catch(() => undefined);
    const connection = this.fanOut({
      ...handlers,
      onEvent: (event, meta) => {
        if (event.type === 'hostsChanged') this.applyHostRecords(event.hosts);
        else handlers.onEvent(event, meta);
      },
      onConnectionChange: (connected) => {
        if (connected) void this.refreshHosts().catch(() => undefined);
        handlers.onConnectionChange(connected);
      },
    });
    return {
      ...connection,
      close: () => {
        this.hostListeners.delete(report);
        connection.close();
      },
    };
  }

  protected async route_listWorkspaces(): Promise<AppWorkspace[]> {
    const workspaces = await this.local.listWorkspaces();
    for (const workspace of workspaces) {
      if (workspace.hostId !== undefined) this.workspaceHost.set(workspace.id, workspace.hostId);
    }
    return workspaces;
  }

  protected async route_addWorkspace({ hostId, ...rest }: Parameters<KimiWebApi['addWorkspace']>[0]): Promise<AppWorkspace> {
    return this.rememberWorkspace(hostId, await this.deviceApi(hostId).addWorkspace(rest));
  }

  protected async route_updateWorkspace(
    id: string,
    input: Parameters<KimiWebApi['updateWorkspace']>[1],
  ): Promise<AppWorkspace> {
    const hostId = this.workspaceHost.get(id);
    return this.rememberWorkspace(hostId, await this.deviceApi(hostId).updateWorkspace(id, input));
  }

  protected async route_setWorkspacePrimary(id: string, path: string): Promise<AppWorkspace> {
    const hostId = this.workspaceHost.get(id);
    return this.rememberWorkspace(hostId, await this.deviceApi(hostId).setWorkspacePrimary(id, path));
  }

  protected async route_deleteWorkspace(id: string): Promise<void> {
    await this.deviceApi(this.workspaceHost.get(id)).deleteWorkspace(id);
    this.workspaceHost.delete(id);
  }

  protected async route_createSession(input: Parameters<KimiWebApi['createSession']>[0]): Promise<AppSession> {
    const hostId = input.workspaceId === undefined ? undefined : this.workspaceHost.get(input.workspaceId);
    return this.rememberSessions(hostId, [await this.deviceApi(hostId).createSession(input)])[0]!;
  }

  protected async route_uploadFile({ hostId, ...rest }: Parameters<KimiWebApi['uploadFile']>[0]): ReturnType<KimiWebApi['uploadFile']> {
    const file = await this.deviceApi(hostId).uploadFile(rest);
    if (hostId !== undefined) this.fileHost.set(file.id, hostId);
    return file;
  }

  private rememberTagged(items: readonly HostTagged[]): void {
    for (const item of items) {
      this.setSessionHost(item.id, item.host_id ?? null);
    }
  }

  protected async route_listSessionIds(
    input?: Parameters<KimiWebApi['listSessionIds']>[0],
  ): ReturnType<KimiWebApi['listSessionIds']> {
    const page = await this.local.listSessionIds(input);
    this.rememberTagged(page.items);
    return page;
  }

  protected async route_listSessionGroups(
    input?: Parameters<KimiWebApi['listSessionGroups']>[0],
    options?: Parameters<KimiWebApi['listSessionGroups']>[1],
  ): ReturnType<KimiWebApi['listSessionGroups']> {
    const page = await this.local.listSessionGroups(input, options);
    for (const group of page.groups) {
      this.rememberTagged(group.sessions.map((session) => ({ id: session.id, host_id: session.hostId })));
    }
    return page;
  }

  protected async route_listSessions(input?: Parameters<KimiWebApi['listSessions']>[0]): ReturnType<KimiWebApi['listSessions']> {
    const hostId = input?.workspaceId === undefined ? undefined : this.workspaceHost.get(input.workspaceId);
    const page = await this.deviceApi(hostId).listSessions(input);
    return { ...page, items: this.rememberSessions(hostId, page.items) };
  }

  private async batchByHost(
    method: 'archiveSessions' | 'restoreSessions',
    ids: string[],
  ): Promise<BatchSessionResponse> {
    const owners = await Promise.all(ids.map((id) => this.ownerOf(id)));
    const grouped = new Map<string | undefined, string[]>();
    ids.forEach((id, index) => {
      const hostId = owners[index];
      grouped.set(hostId, [...(grouped.get(hostId) ?? []), id]);
    });
    const responses = await Promise.all(
      [...grouped].map(([hostId, group]) => this.deviceApi(hostId)[method](group)),
    );
    return { ...responses[0]!, results: responses.flatMap((response) => response.results) };
  }

  protected route_archiveSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.batchByHost('archiveSessions', ids);
  }

  protected route_restoreSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.batchByHost('restoreSessions', ids);
  }

  protected async route_listHosts(): Promise<AppHost[]> {
    await this.refreshHosts();
    return this.hostList();
  }

  protected async route_connectHost(id: string): Promise<AppHost> {
    const host = await this.local.connectHost(id);
    await this.refreshHosts();
    return host;
  }
}
