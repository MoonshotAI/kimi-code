import type {
  AppEvent,
  AppDevice,
  AppSession,
  AppWorkspace,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  BatchSessionResponse,
} from './types';
import type { DaemonKimiWebApi } from './daemon/client';

type Route = 'local' | 'session' | 'sessionSync' | 'localSession' | 'workspace' | 'file' | 'custom';

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
  createFeedback: 'custom',
  updateFeedback: 'custom',
  uploadFeedbackAttachment: 'local',
  uploadFeedbackSession: 'custom',
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
  predictNextPrompt: 'session',
  cancelPromptPrediction: 'session',
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
  inspectMcpAuthStatuses: 'local',
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
  getFileDownloadUrl: 'sessionSync',
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
  listDevices: 'custom',
  putDevice: 'local',
  deleteDevice: 'local',
  connectDevice: 'custom',
  upgradeDevice: 'local',
  testDevice: 'local',
  copyProvidersToDevice: 'local',
  listDeviceSshConfig: 'local',
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
  getSessionMediaUrl: 'sessionSync',
  getSessionMediaBlob: 'session',
  readHostFileContent: 'local',
  downloadHostFile: 'local',
  getConfig: 'local',
  setConfig: 'local',
  readHostTextFile: 'local',
  writeHostTextFile: 'local',
  getAuth: 'local',
  startOAuthLogin: 'local',
  pollOAuthLogin: 'local',
  cancelOAuthLogin: 'local',
  logout: 'local',
  getUsage: 'local',
  getUserInfo: 'local',
  getOAuthRegion: 'local',
  getClientConfig: 'local',
  getSystemStats: 'local',
} as const satisfies Record<keyof KimiWebApi, Route>;

const IMMEDIATE_CUSTOM: ReadonlySet<string> = new Set([
  'dispose', 'connectEvents', 'createFeedback', 'updateFeedback', 'uploadFeedbackSession',
]);

type AnyApi = Record<string, (...args: unknown[]) => unknown>;

interface DeviceClient {
  readonly api: DaemonKimiWebApi;
  record: AppDevice;
}

interface DeviceTagged {
  id: string;
  device_id?: string;
}

export interface DeviceRoutingControls {
  deviceApi(deviceId: string | undefined): KimiWebApi;
}

function isRoutedMethod(method: string): method is keyof typeof ROUTES {
  return Object.hasOwn(ROUTES, method);
}

export class DeviceRouter implements DeviceRoutingControls {
  private readonly devices = new Map<string, DeviceClient>();
  private readonly sessionDevice = new Map<string, string | null>();
  private readonly onSessionDeviceChanged = new Set<(sessionId: string, deviceId: string | null) => void>();

  private setSessionDevice(sessionId: string, deviceId: string | null): void {
    const previous = this.sessionDevice.get(sessionId);
    this.sessionDevice.set(sessionId, deviceId);
    if (previous !== deviceId) {
      for (const listener of this.onSessionDeviceChanged) listener(sessionId, deviceId);
    }
  }
  private readonly lookups = new Map<string, Promise<AppSession>>();
  private readonly workspaceDevice = new Map<string, string>();
  private readonly fileDevice = new Map<string, string>();
  private readonly streamSyncs = new Set<() => void>();
  private readonly deviceListeners = new Set<(devices: AppDevice[]) => void>();
  private reportedDevices: string | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly local: DaemonKimiWebApi,
    private readonly createDeviceClient: (deviceId: string) => DaemonKimiWebApi,
  ) {}

  createApi(): KimiWebApi & DeviceRoutingControls {
    return new Proxy({} as KimiWebApi & DeviceRoutingControls, {
      get: (_target, property) => {
        if (property === 'deviceApi') return this.deviceApi.bind(this);
        if (typeof property !== 'string' || !isRoutedMethod(property)) return undefined;
        return (...args: unknown[]) => this.invoke(property, args);
      },
    });
  }

  deviceApi(deviceId: string | undefined): KimiWebApi {
    return deviceId === undefined ? this.local : this.clientFor(deviceId);
  }

  private invoke(method: keyof typeof ROUTES, args: unknown[]): unknown {
    const route: Route = ROUTES[method];
    if (route !== 'custom') return this.dispatch(method, route, args);
    const custom = (this as unknown as AnyApi)[`route_${method}`]!;
    if (IMMEDIATE_CUSTOM.has(method)) return custom.apply(this, args);
    return this.whenReady().then(() => custom.apply(this, args));
  }

  private whenReady(): Promise<void> {
    this.ready ??= this.refreshDevices().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async refreshDevices(): Promise<void> {
    this.applyDeviceRecords(await this.local.listDevices());
  }

  private applyDeviceRecords(records: readonly AppDevice[]): void {
    const known = new Set(records.map((record) => record.id));
    const removed = new Set<string>();
    for (const id of this.devices.keys()) {
      if (known.has(id)) continue;
      removed.add(id);
      this.devices.get(id)?.api.dispose();
      this.devices.delete(id);
    }
    if (removed.size > 0) {
      for (const [id, deviceId] of this.workspaceDevice) {
        if (removed.has(deviceId)) this.workspaceDevice.delete(id);
      }
      for (const [id, deviceId] of this.sessionDevice) {
        if (deviceId !== null && removed.has(deviceId)) this.sessionDevice.delete(id);
      }
      for (const [id, deviceId] of this.fileDevice) {
        if (removed.has(deviceId)) this.fileDevice.delete(id);
      }
    }
    for (const record of records) {
      const existing = this.devices.get(record.id);
      if (existing === undefined) this.devices.set(record.id, { api: this.createDeviceClient(record.id), record });
      else existing.record = record;
    }
    for (const sync of this.streamSyncs) sync();
    this.reportDevices();
  }

  private reportDevices(): void {
    const devices = this.deviceList();
    const key = JSON.stringify(devices);
    if (key === this.reportedDevices) return;
    this.reportedDevices = key;
    for (const listener of this.deviceListeners) listener(devices);
  }

  private deviceList(): AppDevice[] {
    return [...this.devices.values()].map((device) => device.record);
  }

  private clientFor(deviceId: string): DaemonKimiWebApi {
    const device = this.devices.get(deviceId);
    if (device === undefined) throw new Error(`Device "${deviceId}" is not configured`);
    return device.api;
  }

  private apiFor(deviceId: string | undefined): AnyApi {
    return this.deviceApi(deviceId) as unknown as AnyApi;
  }

  private dispatch(method: string, route: Exclude<Route, 'custom'>, args: unknown[]): unknown {
    const key = args[0] as string;
    if (route === 'session' || route === 'localSession') {
      const owner = this.sessionDevice.get(key);
      if (owner === undefined) return this.dispatchUnknownSession(method, route, args);
      return this.dispatchSession(method, route, args, owner ?? undefined);
    }
    if (route === 'sessionSync') {
      const owner = this.sessionDevice.get(key);
      if (owner === undefined) void this.ownerOf(key).catch(() => undefined);
      const api = this.apiFor(owner ?? undefined);
      return api[method]!(...args);
    }
    const deviceId = route === 'workspace' ? this.workspaceDevice.get(key) : route === 'file' ? this.fileDevice.get(key) : undefined;
    const api = this.apiFor(deviceId);
    return api[method]!.apply(api, args);
  }

  private async dispatchUnknownSession(method: string, route: 'session' | 'localSession', args: unknown[]): Promise<unknown> {
    const sessionId = args[0] as string;
    await this.whenReady();
    if (this.devices.size === 0) return this.dispatchSession(method, route, args, undefined);
    const session = await this.lookUp(sessionId);
    if (method === 'getSession') return session;
    return this.dispatchSession(method, route, args, session.deviceId);
  }

  private lookUp(sessionId: string): Promise<AppSession> {
    const pending = this.lookups.get(sessionId);
    if (pending !== undefined) return pending;
    const lookup = this.local
      .findSession(sessionId)
      .then((session) => {
        this.setSessionDevice(session.id, session.deviceId ?? null);
        return session;
      })
      .finally(() => {
        this.lookups.delete(sessionId);
      });
    this.lookups.set(sessionId, lookup);
    return lookup;
  }

  private async ownerOf(sessionId: string): Promise<string | undefined> {
    const owner = this.sessionDevice.get(sessionId);
    if (owner !== undefined) return owner ?? undefined;
    await this.whenReady();
    if (this.devices.size === 0) return undefined;
    return this.lookUp(sessionId).then((session) => session.deviceId);
  }

  private dispatchSession(method: string, route: 'session' | 'localSession', args: unknown[], deviceId: string | undefined): unknown {
    if (route === 'localSession' && deviceId !== undefined) {
      return Promise.reject(new Error('This action is not available for projects on a remote device'));
    }
    const api = this.apiFor(deviceId);
    const result = api[method]!.apply(api, args);
    if (method === 'forkSession') {
      return (result as Promise<{ id?: string }>).then((session) => {
        if (session.id !== undefined) this.setSessionDevice(session.id, deviceId ?? null);
        return session;
      });
    }
    return result;
  }

  private rememberSessions(deviceId: string | undefined, sessions: readonly AppSession[]): AppSession[] {
    for (const session of sessions) this.setSessionDevice(session.id, deviceId ?? session.deviceId ?? null);
    return deviceId === undefined ? [...sessions] : sessions.map((session) => ({ ...session, deviceId }));
  }

  private rememberWorkspace(deviceId: string | undefined, workspace: AppWorkspace): AppWorkspace {
    if (deviceId === undefined) return workspace;
    this.workspaceDevice.set(workspace.id, deviceId);
    return { ...workspace, deviceId };
  }

  private rewriteEvent(deviceId: string, event: AppEvent): AppEvent {
    switch (event.type) {
      case 'workspaceCreated':
      case 'workspaceUpdated':
        return { ...event, workspace: this.rememberWorkspace(deviceId, event.workspace) };
      case 'workspaceDeleted':
        this.workspaceDevice.delete(event.workspaceId);
        return event;
      case 'sessionCreated':
        this.setSessionDevice(event.session.id, deviceId);
        return event;
      case 'sessionArchived':
      case 'sessionRestored':
      case 'sessionWorkChanged':
      case 'sessionMetaUpdated':
      case 'approvalRequested':
      case 'questionRequested':
      case 'interactionsReset':
        this.setSessionDevice(event.sessionId, deviceId);
        return event;
      case 'sessionDeleted':
        this.sessionDevice.delete(event.sessionId);
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
    const connectionFor = (deviceId: string | null | undefined): KimiEventConnection | undefined =>
      deviceId === undefined || deviceId === null ? local : remote.get(deviceId);
    const onOwnerChanged = (sessionId: string, deviceId: string | null): void => {
      const connection = connectionFor(deviceId);
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
        if (this.devices.get(id)?.record.status === 'ready') continue;
        connection.close();
        remote.delete(id);
      }
      for (const [id, device] of this.devices) {
        if (device.record.status !== 'ready' || remote.has(id)) continue;
        const connection = device.api.connectEvents(this.deviceHandlers(id, handlers));
        remote.set(id, connection);
        for (const [sessionId, agents] of subscriptions) {
          if (this.sessionDevice.get(sessionId) !== id) continue;
          for (const agentId of agents) connection.subscribeConversation(sessionId, agentId);
        }
        for (const watch of taskWatches.values()) {
          if (this.sessionDevice.get(watch.sessionId) === id) {
            connection.watchTaskOutput(watch.sessionId, watch.agentId, watch.taskId);
          }
        }
      }
    };
    this.streamSyncs.add(sync);
    this.onSessionDeviceChanged.add(onOwnerChanged);
    sync();
    const forSession = (sessionId: string): KimiEventConnection | undefined =>
      connectionFor(this.sessionDevice.get(sessionId));
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
        this.onSessionDeviceChanged.delete(onOwnerChanged);
        subscriptions.clear();
        taskWatches.clear();
        local.close();
        for (const connection of remote.values()) connection.close();
        remote.clear();
      },
    };
  }

  private deviceHandlers(deviceId: string, handlers: KimiEventHandlers): KimiEventHandlers {
    let stale = true;
    return {
      ...handlers,
      onEvent: (event, meta) => {
        handlers.onEvent(this.rewriteEvent(deviceId, event), { ...meta, deviceId });
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
    this.onSessionDeviceChanged.clear();
    this.deviceListeners.clear();
    for (const device of this.devices.values()) device.api.dispose();
    this.devices.clear();
    this.local.dispose();
  }

  protected route_connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const report = (devices: AppDevice[]): void => handlers.onEvent({ type: 'devicesChanged', devices }, { sessionId: '' });
    this.deviceListeners.add(report);
    if (this.reportedDevices !== undefined) report(this.deviceList());
    void this.whenReady().catch(() => undefined);
    const connection = this.fanOut({
      ...handlers,
      onEvent: (event, meta) => {
        if (event.type === 'devicesChanged') this.applyDeviceRecords(event.devices);
        else handlers.onEvent(event, meta);
      },
      onConnectionChange: (connected) => {
        if (connected) void this.refreshDevices().catch(() => undefined);
        handlers.onConnectionChange(connected);
      },
    });
    return {
      ...connection,
      close: () => {
        this.deviceListeners.delete(report);
        connection.close();
      },
    };
  }

  protected async route_listWorkspaces(): Promise<AppWorkspace[]> {
    const workspaces = await this.local.listWorkspaces();
    for (const workspace of workspaces) {
      if (workspace.deviceId !== undefined) this.workspaceDevice.set(workspace.id, workspace.deviceId);
    }
    return workspaces;
  }

  protected async route_addWorkspace({ deviceId, ...rest }: Parameters<KimiWebApi['addWorkspace']>[0]): Promise<AppWorkspace> {
    return this.rememberWorkspace(deviceId, await this.deviceApi(deviceId).addWorkspace(rest));
  }

  protected async route_updateWorkspace(
    id: string,
    input: Parameters<KimiWebApi['updateWorkspace']>[1],
  ): Promise<AppWorkspace> {
    const deviceId = this.workspaceDevice.get(id);
    return this.rememberWorkspace(deviceId, await this.deviceApi(deviceId).updateWorkspace(id, input));
  }

  protected async route_setWorkspacePrimary(id: string, path: string): Promise<AppWorkspace> {
    const deviceId = this.workspaceDevice.get(id);
    return this.rememberWorkspace(deviceId, await this.deviceApi(deviceId).setWorkspacePrimary(id, path));
  }

  protected async route_deleteWorkspace(id: string): Promise<void> {
    await this.deviceApi(this.workspaceDevice.get(id)).deleteWorkspace(id);
    this.workspaceDevice.delete(id);
  }

  protected async route_createSession(input: Parameters<KimiWebApi['createSession']>[0]): Promise<AppSession> {
    const deviceId = input.workspaceId === undefined ? undefined : this.workspaceDevice.get(input.workspaceId);
    return this.rememberSessions(deviceId, [await this.deviceApi(deviceId).createSession(input)])[0]!;
  }

  protected async route_createFeedback(input: Parameters<KimiWebApi['createFeedback']>[0]): ReturnType<KimiWebApi['createFeedback']> {
    const api = input.kind === 'turn' ? this.deviceApi(await this.ownerOf(input.session_id)) : this.local;
    return api.createFeedback(input);
  }

  protected async route_updateFeedback(...[feedbackId, input, sessionId]: Parameters<KimiWebApi['updateFeedback']>): ReturnType<KimiWebApi['updateFeedback']> {
    const api = sessionId === undefined ? this.local : this.deviceApi(await this.ownerOf(sessionId));
    return api.updateFeedback(feedbackId, input);
  }

  protected async route_uploadFeedbackSession(...[feedbackId, sessionId, signal, globalFeedback]: Parameters<KimiWebApi['uploadFeedbackSession']>): ReturnType<KimiWebApi['uploadFeedbackSession']> {
    if (globalFeedback !== undefined) return this.local.uploadFeedbackSession(feedbackId, sessionId, signal, globalFeedback);
    return this.deviceApi(await this.ownerOf(sessionId)).uploadFeedbackSession(feedbackId, sessionId, signal);
  }

  protected async route_uploadFile({ deviceId, ...rest }: Parameters<KimiWebApi['uploadFile']>[0]): ReturnType<KimiWebApi['uploadFile']> {
    const file = await this.deviceApi(deviceId).uploadFile(rest);
    if (deviceId !== undefined) this.fileDevice.set(file.id, deviceId);
    return file;
  }

  private rememberTagged(items: readonly DeviceTagged[]): void {
    for (const item of items) {
      this.setSessionDevice(item.id, item.device_id ?? null);
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
      this.rememberTagged(group.sessions.map((session) => ({ id: session.id, device_id: session.deviceId })));
    }
    return page;
  }

  protected async route_listSessions(input?: Parameters<KimiWebApi['listSessions']>[0]): ReturnType<KimiWebApi['listSessions']> {
    const deviceId = input?.workspaceId === undefined ? undefined : this.workspaceDevice.get(input.workspaceId);
    const page = await this.deviceApi(deviceId).listSessions(input);
    return { ...page, items: this.rememberSessions(deviceId, page.items) };
  }

  private async batchByDevice(
    method: 'archiveSessions' | 'restoreSessions',
    ids: string[],
  ): Promise<BatchSessionResponse> {
    const owners = await Promise.all(ids.map((id) => this.ownerOf(id)));
    const grouped = new Map<string | undefined, string[]>();
    ids.forEach((id, index) => {
      const deviceId = owners[index];
      grouped.set(deviceId, [...(grouped.get(deviceId) ?? []), id]);
    });
    const responses = await Promise.all(
      [...grouped].map(([deviceId, group]) => this.deviceApi(deviceId)[method](group)),
    );
    return { ...responses[0]!, results: responses.flatMap((response) => response.results) };
  }

  protected route_archiveSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.batchByDevice('archiveSessions', ids);
  }

  protected route_restoreSessions(ids: string[]): Promise<BatchSessionResponse> {
    return this.batchByDevice('restoreSessions', ids);
  }

  protected async route_listDevices(): Promise<AppDevice[]> {
    await this.refreshDevices();
    return this.deviceList();
  }

  protected async route_connectDevice(id: string): Promise<AppDevice> {
    const device = await this.local.connectDevice(id);
    await this.refreshDevices();
    return device;
  }
}
