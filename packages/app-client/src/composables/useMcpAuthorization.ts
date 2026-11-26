import { reactive } from 'vue';
import type {
  AppMcpAuthState,
  AppMcpAuthStatus,
  AppPluginCapabilities,
} from '@moonshot-ai/app-core/api';
import { getKimiWebApi, t } from '../client/deps';
import { toast } from '../client/toast';

export interface McpAuthorizationTarget {
  pluginId: string;
  serverName: string;
  runtimeName: string;
}

export type McpAuthorizationPhase = 'idle' | 'starting' | 'waiting' | 'cancelling' | 'resetting';

export interface McpAuthorizationViewState {
  status?: AppMcpAuthState;
  phase: McpAuthorizationPhase;
  flowId?: string;
  authorizationUrl?: string;
  discoveryError?: string;
  openBlocked?: boolean;
  cancelled?: boolean;
}

interface ActiveFlow {
  flowId: string;
  authorizationUrl: string;
  controller: AbortController;
  targets: Map<string, McpAuthorizationTarget>;
}

const AUTHORIZATION_TIMEOUT_MS = 900_000;
const states = reactive<Record<string, McpAuthorizationViewState>>({});
const operations = new Map<string, Promise<void>>();
const activeFlows = new Map<string, ActiveFlow>();
const controllers = new Map<string, AbortController>();
const openedFlowIds = new Set<string>();
const openedRuntimeFlowIds = new Map<string, string>();
let refreshGeneration = 0;

function flowForRuntime(runtimeName: string): ActiveFlow | undefined {
  for (const flow of activeFlows.values()) {
    if (flow.targets.has(runtimeName)) return flow;
  }
  return undefined;
}

function markFlowOpened(runtimeName: string, flowId: string): void {
  openedFlowIds.add(flowId);
  openedRuntimeFlowIds.set(runtimeName, flowId);
}

function clearOpenedFlow(runtimeName: string, flowId: string): void {
  openedFlowIds.delete(flowId);
  if (openedRuntimeFlowIds.get(runtimeName) === flowId) {
    openedRuntimeFlowIds.delete(runtimeName);
  }
}

function clearOpenedRuntime(runtimeName: string): void {
  const flowId = openedRuntimeFlowIds.get(runtimeName);
  if (flowId === undefined) return;
  clearOpenedFlow(runtimeName, flowId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showAuthorizationError(titleKey: string, error: unknown): void {
  toast({
    mode: 'replace',
    variant: 'danger',
    title: t(titleKey),
    message: errorMessage(error),
    duration: 5_000,
  });
}

interface PluginAuthorizationSnapshot {
  capabilities: AppPluginCapabilities;
  statuses: AppMcpAuthStatus[];
}

async function inspectPluginAuthorization(pluginId: string): Promise<PluginAuthorizationSnapshot> {
  const [capabilities, offlineStatuses] = await Promise.all([
    getKimiWebApi().getPluginInfo(pluginId),
    getKimiWebApi().getMcpAuthStatuses(),
  ]);
  const remoteServers = capabilities.mcpServers.filter(
    (item) => item.enabled && item.transport !== 'stdio',
  );
  if (remoteServers.length === 0) return { capabilities, statuses: offlineStatuses };
  const inspections = await getKimiWebApi().inspectMcpAuthStatuses(
    remoteServers.map((item) => ({
      source: 'plugin',
      pluginId,
      serverName: item.name,
    })),
  );
  const inspectedByName = new Map(
    inspections.map((item) => [item.name, item.authStatus]),
  );
  const offlineByName = new Map(
    offlineStatuses.map((item) => [item.name, item.authStatus]),
  );
  const statuses = capabilities.mcpServers.map((item) => {
    const inspected = inspectedByName.get(item.runtimeName);
    const offline = offlineByName.get(item.runtimeName);
    if (inspected === 'not-applicable' && offline === 'oauth-required') {
      return { name: item.runtimeName, authStatus: offline };
    }
    const authStatus = inspected === undefined || inspected === 'unavailable'
      ? offline ?? 'unavailable'
      : inspected;
    return { name: item.runtimeName, authStatus };
  });
  return { capabilities, statuses };
}

function invalidatePluginStatuses(pluginId: string): void {
  const prefix = `plugin-${pluginId}:`;
  for (const [key, state] of Object.entries(states)) {
    if (!key.startsWith(prefix) || state?.phase !== 'idle') continue;
    states[key] = { ...state, status: undefined };
  }
}

async function refresh(pluginId?: string): Promise<void> {
  const generation = ++refreshGeneration;
  if (pluginId !== undefined) invalidatePluginStatuses(pluginId);
  try {
    const statuses = pluginId === undefined
      ? await getKimiWebApi().getMcpAuthStatuses()
      : (await inspectPluginAuthorization(pluginId)).statuses;
    if (generation !== refreshGeneration) return;
    for (const key of Object.keys(states)) states[key]!.discoveryError = undefined;
    for (const item of statuses) {
      const previous = states[item.name];
      const next: McpAuthorizationViewState = {
        ...previous,
        status: item.authStatus,
        phase: previous?.phase ?? 'idle',
      };
      if (item.authStatus === 'oauth-authorized') {
        next.cancelled = undefined;
      }
      states[item.name] = next;
    }
  } catch (error) {
    if (generation === refreshGeneration) throw error;
  }
}

type AuthorizationPopup = Window | null | undefined;

function prepareAuthorizationPopup(): AuthorizationPopup {
  const desktop = (window as {
    kimiDesktop?: { openExternal?: (url: string) => Promise<void> };
  }).kimiDesktop;
  if (desktop?.openExternal !== undefined) return undefined;
  try {
    const popup = window.open('about:blank', '_blank');
    if (popup !== null) popup.opener = null;
    return popup;
  } catch {
    return null;
  }
}

async function openFlow(
  target: McpAuthorizationTarget,
  flow: ActiveFlow,
  popup: AuthorizationPopup,
): Promise<void> {
  if (openedFlowIds.has(flow.flowId)) return;
  markFlowOpened(target.runtimeName, flow.flowId);
  let blocked = false;
  try {
    const desktop = (window as {
      kimiDesktop?: { openExternal?: (url: string) => Promise<void> };
    }).kimiDesktop;
    if (desktop?.openExternal !== undefined) {
      popup?.close();
      await desktop.openExternal(flow.authorizationUrl);
    } else if (popup === null) {
      blocked = true;
    } else if (popup !== undefined) {
      if (popup.closed) {
        blocked = true;
      } else {
        popup.location.href = flow.authorizationUrl;
        popup.opener = null;
      }
    } else {
      const opened = window.open(flow.authorizationUrl, '_blank');
      blocked = opened === null;
      if (opened !== null) opened.opener = null;
    }
  } catch {
    blocked = true;
  }
  if (blocked && activeFlows.get(flow.flowId) === flow) {
    states[target.runtimeName] = {
      ...states[target.runtimeName],
      phase: 'waiting',
      openBlocked: true,
    };
  }
}

async function watchCompletion(flow: ActiveFlow, completion: Promise<null>): Promise<void> {
  try {
    await completion;
    if (activeFlows.get(flow.flowId) !== flow) return;
    activeFlows.delete(flow.flowId);
    for (const [runtimeName, target] of flow.targets) {
      controllers.delete(runtimeName);
      states[runtimeName] = {
        ...states[runtimeName],
        status: 'oauth-authorized',
        phase: 'idle',
        flowId: undefined,
        authorizationUrl: undefined,
        openBlocked: undefined,
        cancelled: undefined,
      };
      const pluginState = states[target.pluginId];
      if (pluginState !== undefined) pluginState.discoveryError = undefined;
    }
    await refresh().catch(() => undefined);
  } catch (error) {
    if (activeFlows.get(flow.flowId) !== flow) return;
    activeFlows.delete(flow.flowId);
    const cancelled = flow.controller.signal.aborted ||
      [...flow.targets.keys()].every((name) => states[name]?.phase === 'cancelling');
    for (const runtimeName of flow.targets.keys()) {
      controllers.delete(runtimeName);
      clearOpenedFlow(runtimeName, flow.flowId);
      states[runtimeName] = {
        ...states[runtimeName],
        phase: 'idle',
        flowId: undefined,
        authorizationUrl: undefined,
        openBlocked: undefined,
        cancelled: cancelled ? true : undefined,
      };
    }
    if (!cancelled) showAuthorizationError('settings.plugins.authorizationFailed', error);
  }
}

async function performAuthorization(
  target: McpAuthorizationTarget,
  controller: AbortController,
  popup: AuthorizationPopup,
): Promise<void> {
  let flow: ActiveFlow | undefined;
  try {
    states[target.runtimeName] = {
      ...states[target.runtimeName],
      status: undefined,
      phase: 'starting',
      openBlocked: undefined,
      cancelled: undefined,
    };
    const result = await getKimiWebApi().beginMcpAuth({
      source: 'plugin',
      pluginId: target.pluginId,
      serverName: target.serverName,
    });
    if (controller.signal.aborted) {
      popup?.close();
      if (result.status === 'authorization-required') {
        await getKimiWebApi().cancelMcpAuth(result.flowId).catch(() => undefined);
      }
      return;
    }
    if (result.status === 'already-authorized') {
      popup?.close();
      controllers.delete(target.runtimeName);
      states[target.runtimeName] = {
        ...states[target.runtimeName],
        status: 'oauth-authorized',
        phase: 'idle',
        openBlocked: undefined,
        cancelled: undefined,
      };
      return;
    }
    const shared = activeFlows.get(result.flowId);
    if (shared !== undefined) {
      controllers.delete(target.runtimeName);
      shared.targets.set(target.runtimeName, target);
      states[target.runtimeName] = {
        ...states[target.runtimeName],
        status: 'oauth-required',
        phase: 'waiting',
        flowId: shared.flowId,
        authorizationUrl: shared.authorizationUrl,
      };
      popup?.close();
      return;
    }
    flow = {
      flowId: result.flowId,
      authorizationUrl: result.authorizationUrl,
      controller,
      targets: new Map([[target.runtimeName, target]]),
    };
    activeFlows.set(flow.flowId, flow);
    states[target.runtimeName] = {
      ...states[target.runtimeName],
      status: 'oauth-required',
      phase: 'waiting',
      flowId: flow.flowId,
      authorizationUrl: flow.authorizationUrl,
    };
    const completion = getKimiWebApi().completeMcpAuth({
      flowId: flow.flowId,
      timeoutMs: AUTHORIZATION_TIMEOUT_MS,
      signal: controller.signal,
    });
    void watchCompletion(flow, completion);
    await openFlow(target, flow, popup);
  } catch (error) {
    popup?.close();
    if (flow !== undefined) {
      activeFlows.delete(flow.flowId);
      clearOpenedFlow(target.runtimeName, flow.flowId);
    }
    controllers.delete(target.runtimeName);
    states[target.runtimeName] = {
      ...states[target.runtimeName],
      status: states[target.runtimeName]?.status ?? 'oauth-required',
      phase: 'idle',
      flowId: undefined,
      authorizationUrl: undefined,
      openBlocked: undefined,
    };
    if (!controller.signal.aborted) showAuthorizationError('settings.plugins.authorizationFailed', error);
  }
}

export function useMcpAuthorization() {
  async function authorize(
    target: McpAuthorizationTarget,
    popup?: AuthorizationPopup,
  ): Promise<void> {
    if (flowForRuntime(target.runtimeName) !== undefined) {
      popup?.close();
      return;
    }
    const existing = operations.get(target.runtimeName);
    if (existing !== undefined) {
      popup?.close();
      return existing;
    }
    const preparedPopup = popup === undefined ? prepareAuthorizationPopup() : popup;
    const controller = new AbortController();
    controllers.set(target.runtimeName, controller);
    const operation = performAuthorization(target, controller, preparedPopup);
    operations.set(target.runtimeName, operation);
    try {
      await operation;
    } finally {
      if (operations.get(target.runtimeName) === operation) operations.delete(target.runtimeName);
    }
  }

  async function cancel(runtimeName: string): Promise<void> {
    const flow = flowForRuntime(runtimeName);
    if (flow === undefined) return;
    states[runtimeName] = {
      ...states[runtimeName],
      phase: 'cancelling',
      cancelled: undefined,
    };
    if (flow.targets.size > 1) {
      flow.targets.delete(runtimeName);
      controllers.delete(runtimeName);
      clearOpenedRuntime(runtimeName);
      states[runtimeName] = {
        ...states[runtimeName],
        phase: 'idle',
        flowId: undefined,
        authorizationUrl: undefined,
        openBlocked: undefined,
        cancelled: true,
      };
      return;
    }
    try {
      await getKimiWebApi().cancelMcpAuth(flow.flowId);
    } catch (error) {
      if (activeFlows.get(flow.flowId) === flow) {
        states[runtimeName] = {
          ...states[runtimeName],
          phase: 'waiting',
          flowId: flow.flowId,
          authorizationUrl: flow.authorizationUrl,
        };
        showAuthorizationError('settings.plugins.resetAuthorizationFailed', error);
      }
      return;
    }
    const currentFlow = flowForRuntime(runtimeName);
    if (currentFlow !== undefined && currentFlow !== flow) return;
    activeFlows.delete(flow.flowId);
    controllers.delete(runtimeName);
    clearOpenedFlow(runtimeName, flow.flowId);
    flow.controller.abort();
    states[runtimeName] = {
      ...states[runtimeName],
      phase: 'idle',
      flowId: undefined,
      authorizationUrl: undefined,
      openBlocked: undefined,
      cancelled: true,
    };
  }

  async function reset(target: McpAuthorizationTarget): Promise<void> {
    const existing = operations.get(target.runtimeName);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      states[target.runtimeName] = {
        ...states[target.runtimeName],
        phase: 'resetting',
        cancelled: undefined,
      };
      try {
        await getKimiWebApi().resetMcpAuth({
          source: 'plugin',
          pluginId: target.pluginId,
          serverName: target.serverName,
        });
        clearOpenedRuntime(target.runtimeName);
        states[target.runtimeName] = {
          ...states[target.runtimeName],
          status: 'oauth-required',
          phase: 'idle',
          flowId: undefined,
          authorizationUrl: undefined,
          openBlocked: undefined,
          cancelled: true,
        };
        await refresh(target.pluginId).catch(() => undefined);
      } catch (error) {
        states[target.runtimeName] = {
          ...states[target.runtimeName],
          phase: 'idle',
        };
        showAuthorizationError('settings.plugins.resetAuthorizationFailed', error);
      }
    })();
    operations.set(target.runtimeName, operation);
    try {
      await operation;
    } finally {
      if (operations.get(target.runtimeName) === operation) operations.delete(target.runtimeName);
    }
  }

  async function authorizePlugin(pluginId: string): Promise<void> {
    invalidatePluginStatuses(pluginId);
    states[pluginId] = { ...states[pluginId], phase: 'starting', discoveryError: undefined };
    try {
      const { capabilities, statuses } = await inspectPluginAuthorization(pluginId);
      const required = new Set(
        statuses
          .filter((item) => item.authStatus === 'oauth-required' || item.authStatus === 'oauth-expired')
          .map((item) => item.name),
      );
      const server = capabilities.mcpServers.find((item) => required.has(item.runtimeName));
      if (server === undefined) return;
      await authorize({ pluginId, serverName: server.name, runtimeName: server.runtimeName });
    } catch (error) {
      states[pluginId] = {
        ...states[pluginId],
        discoveryError: errorMessage(error),
      };
    } finally {
      states[pluginId] = { ...states[pluginId], phase: 'idle' };
    }
  }

  return {
    states: states as Readonly<Record<string, McpAuthorizationViewState>>,
    refresh,
    authorize,
    authorizePlugin,
    cancel,
    reset,
  };
}

export function __resetMcpAuthorizationForTests(): void {
  refreshGeneration += 1;
  for (const controller of controllers.values()) controller.abort();
  operations.clear();
  activeFlows.clear();
  controllers.clear();
  openedFlowIds.clear();
  openedRuntimeFlowIds.clear();
  for (const key of Object.keys(states)) delete states[key];
}
