import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { isDaemonApiError, type AppDevice, type AppDeviceConnectFailure, type AppDeviceDefinition, type AppDeviceTestResult, type AppDeviceUpgradeStatus, type AppProviderCopyResult, type AppSshConfigHosts, type AppSshDeviceDefinition, type AppWarning, type KimiWebApi, type OAuthLoginStartResult, type OAuthRegion } from '@moonshot-ai/app-core/api';
import { deviceDisplayName, deviceDisplayState, deviceInstall, isDeviceBlocked, logWarn, type DeviceDisplayState, type DeviceInstall, type RcDevice } from '@moonshot-ai/app-core/lib';
import { getDeviceApi, getKimiWebApi, t } from '../client/deps';
import { modelsStore } from './models';
import { clientPinia } from './pinia';

export type { DeviceDisplayState, DeviceInstall };

export type DeviceProviderCopy =
  | { readonly status: 'copying' | 'failed' }
  | { readonly status: 'done'; readonly result: AppProviderCopyResult };

export type DeviceAccount =
  | { readonly status: 'signedOut'; readonly modelsReady: boolean }
  | { readonly status: 'signedIn'; readonly modelsReady: boolean };

export interface DeviceSnapshotDiff {
  readonly becameReady: string[];
  readonly becameDisabled: string[];
  readonly removed: string[];
}

export interface DevicesHooks {
  signedIn?: () => boolean;
  localDeviceId?: () => string;
  onDevicesChanged?: (diff: DeviceSnapshotDiff) => void;
  pushWarning?: (warning: AppWarning) => void;
  pushOperationFailure?: (operation: string, err: unknown, opts?: { title?: string; message?: string }) => void;
}

const devicesHooks = shallowRef<DevicesHooks | null>(null);

export function setDevicesHooks(next: DevicesHooks | null): void {
  devicesHooks.value = next;
}

export interface MyDevice {
  readonly id: string;
  readonly registration: RcDevice | undefined;
  readonly device: AppDevice | undefined;
}

const DEVICE_NOT_FOUND_CODE = 40420;
const DEVICE_UNAVAILABLE_CODE = 40926;

const UPGRADABLE_STATES: ReadonlySet<DeviceDisplayState> = new Set(['ready', 'connecting', 'idle', 'outdated', 'failed']);

export function deviceDefinition(device: AppDevice): AppDeviceDefinition {
  if (device.connection === 'account') return { connection: 'account', name: device.name, enabled: device.enabled };
  return { connection: 'ssh', host: device.host ?? '', identityFile: device.identityFile, remoteBin: device.remoteBin, name: device.name, enabled: device.enabled };
}

function isUpgradeInProgress(error: unknown): boolean {
  if (!isDaemonApiError(error) || error.code === undefined || error.code === DEVICE_UNAVAILABLE_CODE) return false;
  return error.code >= 40900 && error.code < 41000;
}

function upgradeFailureMessage(error: unknown): string | undefined {
  if (!isDaemonApiError(error)) return undefined;
  if (error.code === DEVICE_NOT_FOUND_CODE) return t('workspace.deviceUpgrade.removed');
  if (error.code === DEVICE_UNAVAILABLE_CODE) return t('workspace.deviceUpgrade.unavailable');
  return undefined;
}

export const useDevicesStore = defineStore('kimi.devices', () => {
  const byId = ref<Record<string, AppDevice>>({});
  const loaded = ref(false);
  const connecting = ref<Record<string, boolean>>({});
  const providerCopies = ref<Record<string, DeviceProviderCopy>>({});
  const accounts = ref<Record<string, DeviceAccount>>({});
  const loginDeviceId = ref<string | null>(null);
  const focusDeviceId = ref<string | null>(null);
  const addIfEmpty = ref(false);
  const settledFailures = ref<Record<string, AppDeviceConnectFailure>>({});
  const registrations = ref<RcDevice[] | null>(null);
  const maxDevices = ref<number | undefined>(undefined);
  const registrationsLoading = ref(false);
  const registrationsError = ref<string | null>(null);
  const upgradeRequests = ref<Record<string, boolean>>({});
  const accountLoads = new Map<string, number>();
  let registrationsGeneration = 0;

  const devices = computed(() => Object.values(byId.value));
  const localDeviceId = computed(() => devicesHooks.value?.localDeviceId?.() ?? '');
  const signedIn = computed(() => devicesHooks.value?.signedIn?.() ?? false);
  const registrationById = computed(() => new Map((registrations.value ?? []).map((registration) => [registration.device_id, registration])));

  const myDevices = computed<MyDevice[]>(() => {
    const sshMachines = new Set<string>();
    for (const device of devices.value) {
      if (device.connection === 'ssh' && device.enabled !== false && device.deviceId !== undefined) sshMachines.add(device.deviceId);
    }
    const rows: MyDevice[] = [];
    for (const registration of registrations.value ?? []) {
      const device = accountDevice(registration.device_id);
      if (device === undefined && (registration.device_id === localDeviceId.value || sshMachines.has(registration.device_id))) continue;
      rows.push({ id: registration.device_id, registration, device });
    }
    for (const device of devices.value) {
      if (device.connection !== 'account' || registrationById.value.has(device.id)) continue;
      rows.push({ id: device.id, registration: undefined, device });
    }
    return rows.toSorted((a, b) => Number(b.registration?.status === 'online') - Number(a.registration?.status === 'online'));
  });

  function accountDevice(deviceId: string): AppDevice | undefined {
    const device = byId.value[deviceId];
    return device?.connection === 'account' ? device : undefined;
  }

  function rememberSettledFailures(list: readonly AppDevice[]): void {
    const next: Record<string, AppDeviceConnectFailure> = {};
    for (const device of list) {
      if (device.status === 'ready') continue;
      const failure = device.status === 'disconnected' ? device.connectFailure : settledFailures.value[device.id];
      if (failure !== undefined) next[device.id] = failure;
    }
    settledFailures.value = next;
  }

  function applySnapshot(list: readonly AppDevice[]): DeviceSnapshotDiff {
    const previousById = byId.value;
    const nextById = Object.fromEntries(list.map((device) => [device.id, device]));
    const becameReady = list
      .filter((device) => device.status === 'ready' && previousById[device.id]?.status !== 'ready')
      .map((device) => device.id);
    const becameDisabled = list
      .filter((device) => device.enabled === false && previousById[device.id]?.enabled !== false)
      .map((device) => device.id);
    const removed = Object.keys(previousById).filter((deviceId) => nextById[deviceId] === undefined);
    const accountUpgradeFinished = list.some((device) => (
      device.connection === 'account' && device.status === 'ready' && device.upgradeStatus === undefined && previousById[device.id]?.upgradeStatus !== undefined
    ));
    rememberSettledFailures(list);
    byId.value = nextById;
    loaded.value = true;
    for (const deviceId of Object.keys(accounts.value)) {
      if (byId.value[deviceId]?.status !== 'ready') setAccount(deviceId, undefined);
    }
    if (loginDeviceId.value !== null && byId.value[loginDeviceId.value]?.status !== 'ready') loginDeviceId.value = null;
    for (const deviceId of becameReady) void loadAccount(deviceId);
    for (const deviceId of Object.keys(providerCopies.value)) {
      if (byId.value[deviceId] === undefined) setProviderCopy(deviceId, undefined);
    }
    const needsInstall = list.some((device) => device.connection === 'account' && device.connectFailure === 'outdated' && device.install === undefined);
    const canLookUp = signedIn.value && registrations.value === null && registrationsError.value === null && !registrationsLoading.value;
    if ((needsInstall && canLookUp) || (accountUpgradeFinished && signedIn.value)) void loadRegistrations();
    if (removed.length > 0) modelsStore().removeDevices(removed);
    const diff: DeviceSnapshotDiff = { becameReady, becameDisabled, removed };
    devicesHooks.value?.onDevicesChanged?.(diff);
    return diff;
  }

  async function load(): Promise<AppDevice[]> {
    const list = await getKimiWebApi().listDevices();
    applySnapshot(list);
    return list;
  }

  const connectFlights = new Map<string, Promise<AppDevice>>();

  async function connect(deviceId: string): Promise<AppDevice> {
    const flight = connectFlights.get(deviceId);
    if (flight !== undefined) return flight;
    connecting.value = { ...connecting.value, [deviceId]: true };
    const pending = getKimiWebApi().connectDevice(deviceId).finally(() => {
      connectFlights.delete(deviceId);
      const next = { ...connecting.value };
      delete next[deviceId];
      connecting.value = next;
    });
    connectFlights.set(deviceId, pending);
    return pending;
  }

  function reconnectSignedOut(): void {
    for (const device of devices.value) {
      if (device.connection === 'account' && device.status === 'disconnected' && device.connectFailure === 'signed_out') {
        void connect(device.id).catch(() => undefined);
      }
    }
  }

  watch(signedIn, (value) => {
    if (value) {
      reconnectSignedOut();
      return;
    }
    registrationsGeneration += 1;
    registrations.value = null;
    maxDevices.value = undefined;
    registrationsLoading.value = false;
    registrationsError.value = null;
  });

  async function save(deviceId: string, definition: AppDeviceDefinition): Promise<void> {
    await getKimiWebApi().putDevice(deviceId, definition);
    await load();
  }

  async function remove(deviceId: string): Promise<void> {
    await getKimiWebApi().deleteDevice(deviceId);
    await load();
  }

  async function addAccountDevice(deviceId: string): Promise<void> {
    await save(deviceId, { connection: 'account' });
    void connect(deviceId).catch(() => undefined);
  }

  async function loadRegistrations(): Promise<void> {
    const generation = ++registrationsGeneration;
    registrationsLoading.value = true;
    try {
      const list = await getKimiWebApi().listRemoteControlDevices();
      if (generation !== registrationsGeneration) return;
      registrations.value = list.devices;
      maxDevices.value = list.max_devices;
      registrationsError.value = null;
    } catch (err) {
      if (generation !== registrationsGeneration) return;
      registrationsError.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === registrationsGeneration) registrationsLoading.value = false;
    }
  }

  async function renameRegistration(deviceId: string, alias: string): Promise<void> {
    await getKimiWebApi().renameRemoteControlDevice(deviceId, alias.trim());
    const device = accountDevice(deviceId);
    if (device?.name !== undefined) await save(deviceId, { connection: 'account', enabled: device.enabled });
    await loadRegistrations();
  }

  async function deactivateRegistration(deviceId: string): Promise<void> {
    await getKimiWebApi().deactivateRemoteControlDevice(deviceId);
    await loadRegistrations();
  }

  async function deleteRegistration(deviceId: string): Promise<void> {
    await getKimiWebApi().deleteRemoteControlDevice(deviceId);
    if (accountDevice(deviceId) !== undefined) await remove(deviceId);
    await loadRegistrations();
  }

  function test(definition: AppSshDeviceDefinition, signal?: AbortSignal): Promise<AppDeviceTestResult> {
    return getKimiWebApi().testDevice(definition, { signal });
  }

  function loadSshConfig(): Promise<AppSshConfigHosts> {
    return getKimiWebApi().listDeviceSshConfig();
  }

  function setProviderCopy(deviceId: string, copy: DeviceProviderCopy | undefined): void {
    const next = { ...providerCopies.value };
    if (copy === undefined) delete next[deviceId];
    else next[deviceId] = copy;
    providerCopies.value = next;
  }

  async function copyProviders(deviceId: string): Promise<void> {
    if (providerCopies.value[deviceId]?.status === 'copying' || byId.value[deviceId]?.status !== 'ready') return;
    const stillCopying = () => providerCopies.value[deviceId]?.status === 'copying';
    setProviderCopy(deviceId, { status: 'copying' });
    try {
      const result = await getKimiWebApi().copyProvidersToDevice(deviceId);
      if (stillCopying()) setProviderCopy(deviceId, { status: 'done', result });
      if (result.providers.length > 0) {
        void modelsStore().loadDeviceCatalog(deviceId).catch((err: unknown) => {
          logWarn('[kimi-code] loading models from device failed', deviceId, err);
        });
        void loadAccount(deviceId);
      }
    } catch (err) {
      logWarn('[kimi-code] copying model providers to device failed', deviceId, err);
      if (stillCopying()) setProviderCopy(deviceId, { status: 'failed' });
    }
  }

  function upgradeStatus(deviceId: string | undefined): AppDeviceUpgradeStatus | undefined {
    if (deviceId === undefined) return undefined;
    const status = byId.value[deviceId]?.upgradeStatus;
    if (upgradeRequests.value[deviceId] === true && status !== 'restarting') return 'installing';
    return status;
  }

  function canUpgrade(deviceId: string | undefined): boolean {
    if (deviceId === undefined || byId.value[deviceId]?.remoteUpgrade !== true) return false;
    if (byId.value[deviceId]?.connectFailure === 'remote_busy') return false;
    const status = upgradeStatus(deviceId);
    return status !== 'installing' && status !== 'restarting' && UPGRADABLE_STATES.has(displayState(deviceId));
  }

  const upgradeFlights = new Map<string, Promise<void>>();

  function upgrade(deviceId: string): Promise<void> {
    const flight = upgradeFlights.get(deviceId);
    if (flight !== undefined) return flight;
    upgradeRequests.value = { ...upgradeRequests.value, [deviceId]: true };
    const pending = requestUpgrade(deviceId).finally(() => {
      upgradeFlights.delete(deviceId);
      const next = { ...upgradeRequests.value };
      delete next[deviceId];
      upgradeRequests.value = next;
    });
    upgradeFlights.set(deviceId, pending);
    return pending;
  }

  async function requestUpgrade(deviceId: string): Promise<void> {
    const name = displayName(deviceId) || deviceId;
    try {
      const result = await getKimiWebApi().upgradeDevice(deviceId);
      if (result.status === 'started') {
        await refreshUpgradeProgress(deviceId);
        return;
      }
      const guidance = result.status === 'update_on_device' ? 'workspace.deviceUpgrade.updateOnDevice' : 'workspace.deviceUpgrade.unsupported';
      devicesHooks.value?.pushWarning?.({ severity: 'info', title: t(guidance, { name }) });
    } catch (err) {
      if (isUpgradeInProgress(err)) {
        devicesHooks.value?.pushWarning?.({ severity: 'info', title: t('workspace.deviceUpgrade.inProgress', { name }) });
        await refreshUpgradeProgress(deviceId);
        return;
      }
      devicesHooks.value?.pushOperationFailure?.('upgradeDevice', err, {
        title: t('workspace.deviceNotice.upgradeFailed', { name }),
        message: upgradeFailureMessage(err),
      });
    }
  }

  async function refreshUpgradeProgress(deviceId: string): Promise<void> {
    const status = byId.value[deviceId]?.upgradeStatus;
    if (status === 'installing' || status === 'restarting') return;
    await load().catch(() => undefined);
  }

  function setAccount(deviceId: string, account: DeviceAccount | undefined): void {
    const next = { ...accounts.value };
    if (account === undefined) delete next[deviceId];
    else next[deviceId] = account;
    accounts.value = next;
  }

  async function loadAccount(deviceId: string): Promise<void> {
    const load = (accountLoads.get(deviceId) ?? 0) + 1;
    accountLoads.set(deviceId, load);
    const current = () => accountLoads.get(deviceId) === load && byId.value[deviceId]?.status === 'ready';
    try {
      const api = getDeviceApi(deviceId);
      const auth = await api.getAuth();
      if (!current()) return;
      if (auth.managedProvider?.status !== 'authenticated') {
        setAccount(deviceId, { status: 'signedOut', modelsReady: auth.modelsReady });
        return;
      }
      setAccount(deviceId, { status: 'signedIn', modelsReady: auth.modelsReady });
    } catch (err) {
      logWarn('[kimi-code] loading the Kimi account of device failed', deviceId, err);
    }
  }

  async function signOut(deviceId: string): Promise<void> {
    await getDeviceApi(deviceId).logout();
    await loadAccount(deviceId);
    void modelsStore().loadDeviceCatalog(deviceId).catch((err: unknown) => {
      logWarn('[kimi-code] loading models from device failed', deviceId, err);
    });
  }

  function openLogin(deviceId: string): void {
    if (byId.value[deviceId]?.status === 'ready') loginDeviceId.value = deviceId;
  }

  function closeLogin(): void {
    loginDeviceId.value = null;
  }

  function requireLoginApi(): KimiWebApi {
    if (loginDeviceId.value === null) throw new Error('No device is signing in');
    return getDeviceApi(loginDeviceId.value);
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
    const deviceId = loginDeviceId.value;
    if (deviceId === null) return;
    loginDeviceId.value = null;
    void loadAccount(deviceId);
    void modelsStore().loadDeviceCatalog(deviceId).catch((err: unknown) => {
      logWarn('[kimi-code] loading models from device failed', deviceId, err);
    });
  }

  function needsLogin(deviceId: string | undefined): boolean {
    if (deviceId === undefined) return false;
    const account = accounts.value[deviceId];
    return account?.status === 'signedOut' && !account.modelsReady;
  }

  function deviceFor(deviceId: string | undefined): AppDevice | undefined {
    return deviceId === undefined ? undefined : byId.value[deviceId];
  }

  function displayState(deviceId: string | undefined): DeviceDisplayState {
    return deviceDisplayState(deviceId, deviceFor(deviceId), {
      loaded: loaded.value,
      connecting: deviceId !== undefined && connecting.value[deviceId] === true,
      settledFailure: deviceId === undefined ? undefined : settledFailures.value[deviceId],
    });
  }

  function displayName(deviceId: string): string | undefined {
    if (!loaded.value) return '';
    const device = byId.value[deviceId];
    if (device === undefined) return undefined;
    return deviceDisplayName({ ...device, alias: registrationById.value.get(deviceId)?.alias || device.alias });
  }

  function install(deviceId: string): DeviceInstall | undefined {
    const device = byId.value[deviceId];
    if (device?.install !== undefined) return device.install;
    if (device?.connection === 'ssh') return 'cli';
    const registration = registrationById.value.get(deviceId);
    return registration === undefined ? undefined : deviceInstall(registration.client_version)?.install;
  }

  function searchTerms(deviceId: string): string[] {
    const device = deviceFor(deviceId);
    const name = displayName(deviceId);
    return [name ?? '', device?.host ?? ''].filter(Boolean);
  }

  function deviceLabel(deviceId: string, tr: (key: string) => string): string {
    return displayName(deviceId) ?? tr('workspace.deletedDevice');
  }

  function workspacePathLabel(workspace: { shortPath: string; deviceId?: string }, tr: (key: string) => string): string {
    if (workspace.deviceId === undefined) return workspace.shortPath;
    const name = deviceLabel(workspace.deviceId, tr);
    const label = name ? `${name} · ${workspace.shortPath}` : workspace.shortPath;
    if (!blocked(workspace.deviceId)) return label;
    return `${tr(`workspace.deviceState.${displayState(workspace.deviceId)}`)} · ${label}`;
  }

  function unavailable(deviceId: string | undefined): boolean {
    const state = displayState(deviceId);
    return state === 'disabled' || state === 'missing';
  }

  function blocked(deviceId: string | undefined): boolean {
    return isDeviceBlocked(displayState(deviceId));
  }

  function requestFocus(deviceId: string | null, options?: { addIfEmpty?: boolean }): void {
    focusDeviceId.value = deviceId;
    addIfEmpty.value = options?.addIfEmpty === true;
  }

  function takeAddIfEmpty(): boolean {
    const pending = addIfEmpty.value;
    addIfEmpty.value = false;
    return pending;
  }

  return {
    byId,
    devices,
    loaded,
    connecting,
    accounts,
    loginDeviceId,
    focusDeviceId,
    addIfEmpty,
    requestFocus,
    takeAddIfEmpty,
    settledFailures,
    registrations,
    maxDevices,
    registrationsLoading,
    registrationsError,
    localDeviceId,
    myDevices,
    loadAccount,
    signOut,
    openLogin,
    closeLogin,
    startLogin,
    pollLogin,
    cancelLogin,
    loginRegion,
    finishLogin,
    needsLogin,
    applySnapshot,
    load,
    connect,
    reconnectSignedOut,
    save,
    remove,
    addAccountDevice,
    loadRegistrations,
    renameRegistration,
    deactivateRegistration,
    deleteRegistration,
    test,
    loadSshConfig,
    providerCopies,
    copyProviders,
    upgradeRequests,
    upgradeStatus,
    canUpgrade,
    upgrade,
    deviceFor,
    displayState,
    displayName,
    install,
    deviceLabel,
    searchTerms,
    workspacePathLabel,
    unavailable,
    blocked,
  };
});

export function devicesStore() {
  return useDevicesStore(clientPinia);
}
