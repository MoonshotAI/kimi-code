import { getCurrentScope, onScopeDispose, ref } from 'vue';

import { isDaemonApiError, type KimiWebApi, type RemoteControlStatus } from '@moonshot-ai/app-core/api';
import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';

export type RemoteControlApi = Pick<
  KimiWebApi,
  | 'getRemoteControlStatus'
  | 'setRemoteControlEnabled'
  | 'listRemoteControlDevices'
  | 'renameRemoteControlDevice'
  | 'deactivateRemoteControlDevice'
  | 'deleteRemoteControlDevice'
>;

const REMOTE_CONTROL_ALREADY_RUNNING_CODE = 40928;

interface RemoteControlRestoreBridge {
  getRemoteControlRestoreState?: () => Promise<{ restoreEnabled: boolean; previousEnabled: boolean }>;
  setRemoteControlRestoreState?: (patch: {
    restoreEnabled?: boolean;
    previousEnabled?: boolean;
  }) => Promise<void>;
  onRemoteControlRestoreFinished?: (cb: () => void) => () => void;
}

function restoreBridge(): RemoteControlRestoreBridge | undefined {
  return (globalThis as { kimiDesktop?: RemoteControlRestoreBridge }).kimiDesktop;
}

export interface RemoteControlConflictHolder {
  pid: number;
  local_origin: string;
  device_id: string;
  url: string;
  started_at: number;
}

export function alreadyRunningHolder(error: unknown): RemoteControlConflictHolder | undefined {
  if (!isDaemonApiError(error) || error.code !== REMOTE_CONTROL_ALREADY_RUNNING_CODE) {
    return undefined;
  }
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  if (
    typeof record['pid'] !== 'number' ||
    typeof record['local_origin'] !== 'string' ||
    typeof record['device_id'] !== 'string' ||
    typeof record['url'] !== 'string' ||
    typeof record['started_at'] !== 'number'
  ) {
    return undefined;
  }
  return {
    pid: record['pid'],
    local_origin: record['local_origin'],
    device_id: record['device_id'],
    url: record['url'],
    started_at: record['started_at'],
  };
}

export function remoteControlErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length > 0 ? message : fallback;
}

export function useRemoteControl(api: RemoteControlApi = getKimiWebApi()) {
  const status = ref<RemoteControlStatus | null>(null);
  const statusLoading = ref(false);
  const statusError = ref<string | null>(null);
  const toggleError = ref<string | null>(null);
  const conflict = ref<RemoteControlConflictHolder | null>(null);
  const enabling = ref(false);
  const disabling = ref(false);
  const devices = ref<RcDevice[] | null>(null);
  const devicesLoading = ref(false);
  const devicesRefreshing = ref(false);
  const devicesError = ref<string | null>(null);
  const takingOver = ref(false);
  const conflictDialogOpen = ref(false);
  const restoreEnabled = ref(false);
  const restoreStateLoading = ref(false);
  const restoreStateSaving = ref(false);
  const restoreStateError = ref<string | null>(null);

  let statusGeneration = 0;
  let devicesGeneration = 0;
  let devicesPending = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let recordPreviousOnTerminal = false;
  let restoreFinishOff: (() => void) | undefined;

  function scheduleSettlePoll(): void {
    if (disposed || settleTimer !== undefined) return;
    const state = status.value?.state;
    if (state !== 'starting' && state !== 'stopping') return;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      void loadStatus().then(scheduleSettlePoll);
    }, 1000);
  }

  function dispose(): void {
    disposed = true;
    restoreFinishOff?.();
    restoreFinishOff = undefined;
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  }

  if (getCurrentScope() !== null) onScopeDispose(dispose);

  async function loadStatus(): Promise<void> {
    if (enabling.value || disabling.value) return;
    const generation = ++statusGeneration;
    if (status.value === null) statusLoading.value = true;
    try {
      const next = await api.getRemoteControlStatus();
      if (generation !== statusGeneration) return;
      status.value = next;
      await recordTerminalPreviousState(next);
      statusError.value = null;
      conflict.value = next.conflict ?? null;
      scheduleSettlePoll();
    } catch (error) {
      if (generation !== statusGeneration) return;
      statusError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === statusGeneration) statusLoading.value = false;
    }
  }

  async function loadRestoreState(): Promise<void> {
    restoreStateLoading.value = true;
    try {
      const state = await restoreBridge()?.getRemoteControlRestoreState?.();
      restoreEnabled.value = state?.restoreEnabled === true;
      restoreStateError.value = null;
    } catch (error) {
      restoreStateError.value = error instanceof Error ? error.message : String(error);
    } finally {
      restoreStateLoading.value = false;
    }
  }

  async function setRestoreEnabled(enabled: boolean): Promise<void> {
    if (restoreStateSaving.value) return;
    restoreStateSaving.value = true;
    restoreStateError.value = null;
    try {
      await restoreBridge()?.setRemoteControlRestoreState?.({ restoreEnabled: enabled });
      if (enabled) await persistPreviousEnabled(status.value?.enabled === true);
      restoreEnabled.value = enabled;
    } catch (error) {
      restoreStateError.value = error instanceof Error ? error.message : String(error);
    } finally {
      restoreStateSaving.value = false;
    }
  }

  async function persistPreviousEnabled(enabled: boolean): Promise<void> {
    await restoreBridge()?.setRemoteControlRestoreState?.({ previousEnabled: enabled }).catch(() => {});
  }

  async function recordTerminalPreviousState(next: RemoteControlStatus): Promise<void> {
    if (!recordPreviousOnTerminal || (next.state !== 'on' && next.state !== 'off')) return;
    recordPreviousOnTerminal = false;
    await persistPreviousEnabled(next.enabled === true);
  }

  async function open(): Promise<void> {
    disposed = false;
    conflict.value = null;
    restoreFinishOff ??= restoreBridge()?.onRemoteControlRestoreFinished?.(() => {
      void loadStatus();
    });
    await loadRestoreState();
    await loadStatus();
    await refreshDevices();
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    if (enabling.value || disabling.value) return;
    statusGeneration += 1;
    recordPreviousOnTerminal = true;
    toggleError.value = null;
    conflict.value = null;
    if (enabled) enabling.value = true;
    else disabling.value = true;
    try {
      const next = await api.setRemoteControlEnabled(enabled);
      status.value = next;
      await recordTerminalPreviousState(next);
      statusError.value = null;
      scheduleSettlePoll();
      await refreshDevices();
    } catch (error) {
      recordPreviousOnTerminal = false;
      if (enabled) {
        const holder = alreadyRunningHolder(error);
        if (holder !== undefined) {
          conflict.value = holder;
          return;
        }
      }
      toggleError.value = error instanceof Error ? error.message : String(error);
    } finally {
      enabling.value = false;
      disabling.value = false;
    }
  }

  async function refreshDevices(): Promise<void> {
    const generation = ++devicesGeneration;
    devicesPending += 1;
    devicesRefreshing.value = true;
    if (devices.value === null) devicesLoading.value = true;
    try {
      const list = await api.listRemoteControlDevices();
      if (generation !== devicesGeneration) return;
      devices.value = list.devices;
      devicesError.value = null;
    } catch (error) {
      if (generation !== devicesGeneration) return;
      devicesError.value = error instanceof Error ? error.message : String(error);
    } finally {
      devicesPending = Math.max(0, devicesPending - 1);
      devicesRefreshing.value = devicesPending > 0;
      if (generation === devicesGeneration) devicesLoading.value = false;
    }
  }

  async function renameDevice(deviceId: string, alias: string): Promise<void> {
    await api.renameRemoteControlDevice(deviceId, alias.trim());
    await loadStatus();
    await refreshDevices();
  }

  async function deactivateDevice(deviceId: string): Promise<void> {
    const currentDevice = status.value?.device_id === deviceId;
    await api.deactivateRemoteControlDevice(deviceId);
    if (currentDevice) await persistPreviousEnabled(false);
    await loadStatus();
    await refreshDevices();
  }

  async function deleteDevice(deviceId: string): Promise<void> {
    await api.deleteRemoteControlDevice(deviceId);
    await loadStatus();
    await refreshDevices();
  }

  async function takeover(): Promise<void> {
    const holder = conflict.value;
    if (holder === null || takingOver.value || enabling.value || disabling.value) return;
    takingOver.value = true;
    try {
      await api.deactivateRemoteControlDevice(holder.device_id);
    } catch (error) {
      await loadStatus();
      takingOver.value = false;
      throw error;
    }
    try {
      await setEnabled(true);
    } finally {
      takingOver.value = false;
    }
  }

  return {
    status,
    statusLoading,
    statusError,
    toggleError,
    conflict,
    enabling,
    disabling,
    devices,
    devicesLoading,
    devicesRefreshing,
    devicesError,
    takingOver,
    conflictDialogOpen,
    restoreEnabled,
    restoreStateLoading,
    restoreStateSaving,
    restoreStateError,
    loadStatus,
    loadRestoreState,
    open,
    setEnabled,
    setRestoreEnabled,
    refreshDevices,
    renameDevice,
    deactivateDevice,
    deleteDevice,
    takeover,
    dispose,
  };
}

export type RemoteControlController = ReturnType<typeof useRemoteControl>;
