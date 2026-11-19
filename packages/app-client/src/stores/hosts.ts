import { computed, ref, shallowReactive } from 'vue';
import { defineStore } from 'pinia';
import type { AppHost, AppHostDefinition, AppHostTestResult, AppProviderCopyResult, AppSshConfigHosts, KimiWebApi, OAuthLoginStartResult, OAuthRegion } from '@moonshot-ai/app-core/api';
import { hostDisplayName, hostDisplayState, isHostBlocked, logWarn, type HostDisplayState } from '@moonshot-ai/app-core/lib';
import { getDeviceApi, getKimiWebApi } from '../client/deps';
import { modelsStore } from './models';
import { clientPinia } from './pinia';

export type { HostDisplayState };

const HOST_FLAGS_RETRY_DELAY_MS = 1_000;

export type HostProviderCopy =
  | { readonly status: 'copying' | 'failed' }
  | { readonly status: 'done'; readonly result: AppProviderCopyResult };

export type HostAccount =
  | { readonly status: 'signedOut'; readonly modelsReady: boolean }
  | { readonly status: 'signedIn'; readonly modelsReady: boolean };

export interface HostSnapshotDiff {
  readonly becameReady: string[];
  readonly becameDisabled: string[];
  readonly removed: string[];
}

export interface HostsHooks {
  onHostsChanged?: (diff: HostSnapshotDiff) => void;
}

let hostsHooks: HostsHooks | null = null;

export function setHostsHooks(next: HostsHooks | null): void {
  hostsHooks = next;
}

export function hostDefinition(host: AppHost): AppHostDefinition {
  return { host: host.host, identityFile: host.identityFile, remoteBin: host.remoteBin, name: host.name, enabled: host.enabled };
}

export const useHostsStore = defineStore('kimi.hosts', () => {
  const byId = ref<Record<string, AppHost>>({});
  const loaded = ref(false);
  const connecting = ref<Record<string, boolean>>({});
  const providerCopies = ref<Record<string, HostProviderCopy>>({});
  const accounts = ref<Record<string, HostAccount>>({});
  const experimentalFlags = shallowReactive(new Map<string, Readonly<Record<string, boolean>>>());
  const loginHostId = ref<string | null>(null);
  const focusHostId = ref<string | null>(null);
  const addIfEmpty = ref(false);
  const accountLoads = new Map<string, number>();

  const hosts = computed(() => Object.values(byId.value));

  function applySnapshot(list: readonly AppHost[]): HostSnapshotDiff {
    const previousById = byId.value;
    const nextById = Object.fromEntries(list.map((host) => [host.id, host]));
    const becameReady = list
      .filter((host) => host.status === 'ready' && previousById[host.id]?.status !== 'ready')
      .map((host) => host.id);
    const becameDisabled = list
      .filter((host) => host.enabled === false && previousById[host.id]?.enabled !== false)
      .map((host) => host.id);
    const removed = Object.keys(previousById).filter((hostId) => nextById[hostId] === undefined);
    byId.value = nextById;
    loaded.value = true;
    for (const hostId of Object.keys(accounts.value)) {
      if (byId.value[hostId]?.status !== 'ready') setAccount(hostId, undefined);
    }
    if (loginHostId.value !== null && byId.value[loginHostId.value]?.status !== 'ready') loginHostId.value = null;
    for (const hostId of removed) experimentalFlags.delete(hostId);
    for (const { id } of list) {
      if (displayState(id) !== 'ready') experimentalFlags.delete(id);
      else if (!experimentalFlags.has(id)) void loadExperimentalFlags(id);
    }
    for (const hostId of becameReady) void loadAccount(hostId);
    for (const hostId of Object.keys(providerCopies.value)) {
      if (byId.value[hostId] === undefined) setProviderCopy(hostId, undefined);
    }
    if (removed.length > 0) modelsStore().removeHosts(removed);
    const diff: HostSnapshotDiff = { becameReady, becameDisabled, removed };
    hostsHooks?.onHostsChanged?.(diff);
    return diff;
  }

  async function load(): Promise<AppHost[]> {
    const list = await getKimiWebApi().listHosts();
    applySnapshot(list);
    return list;
  }

  const connectFlights = new Map<string, Promise<AppHost>>();

  async function connect(hostId: string): Promise<AppHost> {
    const flight = connectFlights.get(hostId);
    if (flight !== undefined) return flight;
    connecting.value = { ...connecting.value, [hostId]: true };
    const pending = getKimiWebApi().connectHost(hostId).finally(() => {
      connectFlights.delete(hostId);
      const next = { ...connecting.value };
      delete next[hostId];
      connecting.value = next;
    });
    connectFlights.set(hostId, pending);
    return pending;
  }

  async function save(hostId: string, definition: AppHostDefinition): Promise<void> {
    await getKimiWebApi().putHost(hostId, definition);
    await load();
  }

  async function remove(hostId: string): Promise<void> {
    await getKimiWebApi().deleteHost(hostId);
    await load();
  }

  function test(definition: AppHostDefinition, signal?: AbortSignal): Promise<AppHostTestResult> {
    return getKimiWebApi().testHost(definition, { signal });
  }

  function loadSshConfig(): Promise<AppSshConfigHosts> {
    return getKimiWebApi().listHostSshConfig();
  }

  function setProviderCopy(hostId: string, copy: HostProviderCopy | undefined): void {
    const next = { ...providerCopies.value };
    if (copy === undefined) delete next[hostId];
    else next[hostId] = copy;
    providerCopies.value = next;
  }

  async function copyProviders(hostId: string): Promise<void> {
    if (providerCopies.value[hostId]?.status === 'copying' || byId.value[hostId]?.status !== 'ready') return;
    const stillCopying = () => providerCopies.value[hostId]?.status === 'copying';
    setProviderCopy(hostId, { status: 'copying' });
    try {
      const result = await getKimiWebApi().copyProvidersToHost(hostId);
      if (stillCopying()) setProviderCopy(hostId, { status: 'done', result });
      if (result.providers.length > 0) {
        void modelsStore().loadHostCatalog(hostId).catch((err: unknown) => {
          logWarn('[kimi-code] loading models from SSH host failed', hostId, err);
        });
        void loadAccount(hostId);
      }
    } catch (err) {
      logWarn('[kimi-code] copying model providers to SSH host failed', hostId, err);
      if (stillCopying()) setProviderCopy(hostId, { status: 'failed' });
    }
  }

  async function loadExperimentalFlags(hostId: string, retry = true): Promise<void> {
    const pending = {};
    experimentalFlags.set(hostId, pending);
    try {
      const meta = await getDeviceApi(hostId).getMeta();
      if (experimentalFlags.get(hostId) === pending) experimentalFlags.set(hostId, meta.experimentalFlags);
    } catch (error) {
      if (experimentalFlags.get(hostId) !== pending) return;
      if (retry) {
        setTimeout(() => {
          if (experimentalFlags.get(hostId) === pending) void loadExperimentalFlags(hostId, false);
        }, HOST_FLAGS_RETRY_DELAY_MS);
      } else {
        experimentalFlags.delete(hostId);
        logWarn('[kimi-code] loading SSH host flags failed', hostId, error);
      }
    }
  }

  function setAccount(hostId: string, account: HostAccount | undefined): void {
    const next = { ...accounts.value };
    if (account === undefined) delete next[hostId];
    else next[hostId] = account;
    accounts.value = next;
  }

  async function loadAccount(hostId: string): Promise<void> {
    const load = (accountLoads.get(hostId) ?? 0) + 1;
    accountLoads.set(hostId, load);
    const current = () => accountLoads.get(hostId) === load && byId.value[hostId]?.status === 'ready';
    try {
      const api = getDeviceApi(hostId);
      const auth = await api.getAuth();
      if (!current()) return;
      if (auth.managedProvider?.status !== 'authenticated') {
        setAccount(hostId, { status: 'signedOut', modelsReady: auth.modelsReady });
        return;
      }
      setAccount(hostId, { status: 'signedIn', modelsReady: auth.modelsReady });
    } catch (err) {
      logWarn('[kimi-code] loading the Kimi account of SSH host failed', hostId, err);
    }
  }

  async function signOut(hostId: string): Promise<void> {
    await getDeviceApi(hostId).logout();
    await loadAccount(hostId);
    void modelsStore().loadHostCatalog(hostId).catch((err: unknown) => {
      logWarn('[kimi-code] loading models from SSH host failed', hostId, err);
    });
  }

  function openLogin(hostId: string): void {
    if (byId.value[hostId]?.status === 'ready') loginHostId.value = hostId;
  }

  function closeLogin(): void {
    loginHostId.value = null;
  }

  function requireLoginApi(): KimiWebApi {
    if (loginHostId.value === null) throw new Error('No SSH host is signing in');
    return getDeviceApi(loginHostId.value);
  }

  async function startLogin(region?: OAuthRegion): Promise<OAuthLoginStartResult> {
    return requireLoginApi().startOAuthLogin(region);
  }

  async function pollLogin(): ReturnType<KimiWebApi['pollOAuthLogin']> {
    return requireLoginApi().pollOAuthLogin();
  }

  async function cancelLogin(): Promise<void> {
    await requireLoginApi().cancelOAuthLogin();
  }

  async function loginRegion(): Promise<OAuthRegion | null> {
    return requireLoginApi().getOAuthRegion();
  }

  function finishLogin(): void {
    const hostId = loginHostId.value;
    if (hostId === null) return;
    loginHostId.value = null;
    void loadAccount(hostId);
    void modelsStore().loadHostCatalog(hostId).catch((err: unknown) => {
      logWarn('[kimi-code] loading models from SSH host failed', hostId, err);
    });
  }

  function needsLogin(hostId: string | undefined): boolean {
    if (hostId === undefined) return false;
    const account = accounts.value[hostId];
    return account?.status === 'signedOut' && !account.modelsReady;
  }

  function hostFor(hostId: string | undefined): AppHost | undefined {
    return hostId === undefined ? undefined : byId.value[hostId];
  }

  function displayState(hostId: string | undefined): HostDisplayState {
    return hostDisplayState(hostId, hostFor(hostId), {
      loaded: loaded.value,
      connecting: hostId !== undefined && connecting.value[hostId] === true,
    });
  }

  function displayName(hostId: string): string | undefined {
    if (!loaded.value) return '';
    const host = byId.value[hostId];
    return host === undefined ? undefined : hostDisplayName(host);
  }

  function searchTerms(hostId: string): string[] {
    const host = hostFor(hostId);
    const name = displayName(hostId);
    return [name ?? '', host?.host ?? ''].filter(Boolean);
  }

  function hostLabel(hostId: string, tr: (key: string) => string): string {
    return displayName(hostId) ?? tr('workspace.deletedHost');
  }

  function workspacePathLabel(workspace: { shortPath: string; hostId?: string }, tr: (key: string) => string): string {
    if (workspace.hostId === undefined) return workspace.shortPath;
    const name = hostLabel(workspace.hostId, tr);
    const label = name ? `${name} · ${workspace.shortPath}` : workspace.shortPath;
    if (!blocked(workspace.hostId)) return label;
    return `${tr(`workspace.hostState.${displayState(workspace.hostId)}`)} · ${label}`;
  }

  function unavailable(hostId: string | undefined): boolean {
    const state = displayState(hostId);
    return state === 'disabled' || state === 'missing';
  }

  function blocked(hostId: string | undefined): boolean {
    return isHostBlocked(displayState(hostId));
  }

  function requestFocus(hostId: string | null, options?: { addIfEmpty?: boolean }): void {
    focusHostId.value = hostId;
    addIfEmpty.value = options?.addIfEmpty === true;
  }

  function takeAddIfEmpty(): boolean {
    const pending = addIfEmpty.value;
    addIfEmpty.value = false;
    return pending;
  }

  return { byId, hosts, loaded, connecting, accounts, experimentalFlags, loginHostId, focusHostId, addIfEmpty, requestFocus, takeAddIfEmpty, loadAccount, signOut, openLogin, closeLogin, startLogin, pollLogin, cancelLogin, loginRegion, finishLogin, needsLogin, applySnapshot, load, connect, save, remove, test, loadSshConfig, providerCopies, copyProviders, hostFor, displayState, displayName, hostLabel, searchTerms, workspacePathLabel, unavailable, blocked };
});

export function hostsStore() {
  return useHostsStore(clientPinia);
}
