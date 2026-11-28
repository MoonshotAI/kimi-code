import { computed, getCurrentScope, onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from 'vue';
import type {
  SystemPermissionId,
  SystemPermissionItem,
  SystemPermissionsQuery,
  SystemPermissionsSnapshot,
} from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { notificationsStore } from '../stores/notifications';

export interface SystemPermissionsBridge {
  getSystemPermissions: (query: SystemPermissionsQuery) => Promise<SystemPermissionsSnapshot>;
  requestSystemPermission: (id: SystemPermissionId, query: SystemPermissionsQuery) => Promise<SystemPermissionsSnapshot>;
  openSystemPermissionSettings: (id: SystemPermissionId, query: SystemPermissionsQuery) => Promise<SystemPermissionsSnapshot>;
}

export interface SystemPermissionsControllerOptions {
  bridge?: SystemPermissionsBridge;
  listPlugins?: () => Promise<Array<{ id: string }>>;
  notifications?: Pick<ReturnType<typeof notificationsStore>, 'syncPermission' | 'requestPermission'>;
  focusTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface SystemPermissionsController {
  snapshot: Ref<SystemPermissionsSnapshot | null>;
  loading: Ref<boolean>;
  busyId: Ref<SystemPermissionId | null>;
  error: Ref<string | null>;
  hostItems: Ref<SystemPermissionItem[]>;
  computerUseItems: Ref<SystemPermissionItem[]>;
  refresh: () => Promise<void>;
  runAction: (item: SystemPermissionItem) => Promise<void>;
  dispose: () => void;
}

const COMPUTER_USE_PLUGIN_ID = 'kimi-cu';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSystemPermissionsController(options: SystemPermissionsControllerOptions = {}): SystemPermissionsController {
  const snapshot = shallowRef<SystemPermissionsSnapshot | null>(null);
  const loading = ref(false);
  const busyId = ref<SystemPermissionId | null>(null);
  const error = ref<string | null>(null);
  let generation = 0;
  let computerUseInstalled = false;
  let pluginsLoaded = false;
  let disposed = false;

  const bridge = options.bridge ?? (globalThis as { kimiDesktop?: SystemPermissionsBridge }).kimiDesktop;
  const listPlugins = options.listPlugins ?? (() => getKimiWebApi().listPlugins());
  const notifications = options.notifications ?? notificationsStore();

  async function buildQuery(forcePlugins = false): Promise<SystemPermissionsQuery> {
    if (forcePlugins || !pluginsLoaded) {
      try {
        const plugins = await listPlugins();
        computerUseInstalled = plugins.some((plugin) => plugin.id === COMPUTER_USE_PLUGIN_ID);
      } catch {
        computerUseInstalled = false;
      }
      pluginsLoaded = true;
    }
    return {
      computerUseInstalled,
      notificationPermission: notifications.syncPermission(),
    };
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    if (bridge?.getSystemPermissions === undefined) {
      error.value = 'system-permissions: unavailable';
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const query = await buildQuery(true);
      const next = await bridge.getSystemPermissions(query);
      if (disposed || current !== generation) return;
      snapshot.value = next;
    } catch (cause) {
      if (!disposed && current === generation) error.value = errorMessage(cause);
    } finally {
      if (!disposed && current === generation) loading.value = false;
    }
  }

  async function runAction(item: SystemPermissionItem): Promise<void> {
    if (busyId.value !== null || item.action === null) return;
    busyId.value = item.id;
    error.value = null;
    const current = ++generation;
    try {
      if (item.id === 'notifications' && item.action === 'request') {
        await notifications.requestPermission();
        await refresh();
        return;
      }
      const query = await buildQuery();
      const next = item.action === 'request'
        ? await bridge?.requestSystemPermission(item.id, query)
        : await bridge?.openSystemPermissionSettings(item.id, query);
      if (disposed || current !== generation) return;
      if (next !== undefined) snapshot.value = next;
    } catch (cause) {
      if (!disposed && current === generation) error.value = errorMessage(cause);
    } finally {
      if (busyId.value === item.id) busyId.value = null;
    }
  }

  const onFocus = (): void => {
    void refresh();
  };

  options.focusTarget?.addEventListener('focus', onFocus);

  function dispose(): void {
    disposed = true;
    generation++;
    options.focusTarget?.removeEventListener('focus', onFocus);
  }

  if (getCurrentScope() !== undefined) {
    onMounted(() => void refresh());
    onBeforeUnmount(dispose);
  }

  return {
    snapshot,
    loading,
    busyId,
    error,
    hostItems: computed(() => snapshot.value?.items.filter((item) => !item.id.startsWith('cu-')) ?? []),
    computerUseItems: computed(() => snapshot.value?.computerUseInstalled
      ? snapshot.value.items.filter((item) => item.id.startsWith('cu-'))
      : []),
    refresh,
    runAction,
    dispose,
  };
}

export function useSystemPermissions(): SystemPermissionsController {
  return createSystemPermissionsController({
    focusTarget: typeof window === 'undefined' ? undefined : window,
  });
}
