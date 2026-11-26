import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue';
import { track } from '@moonshot-ai/app-client/contracts';
import {
  isKimiCuMacCapability,
  isKimiCuPermissionMissing,
  isWebBridgeExtensionDisconnected,
  readKimiCuPermissions,
  usePlugins,
  type PluginViewModel,
} from '@moonshot-ai/app-client/composables';
import { WEBBRIDGE_EXTENSION_LINKS, type WebBridgeBrowser } from './webBridgeExtension';

const GUIDE_POLL_INTERVAL_MS = 2_000;
const WEBBRIDGE_FOCUS_THROTTLE_MS = 3_000;
const CU_FOCUS_THROTTLE_MS = 500;
const CU_PERMISSION_TIMEOUT_MS = 60_000;

export type PluginGuideEntry = 'install' | 'detail';

export function usePluginCapabilityGuides(rows: ComputedRef<readonly PluginViewModel[]>) {
  const { refreshCapability, requestCapabilityPermissions } = usePlugins();
  const webBridgeGuideOpen = ref(false);
  const webBridgeChecking = ref(false);
  const cuPermissionWaiting = ref(false);

  let guideFirstShownAt: number | null = null;
  let guidePollTimer: ReturnType<typeof setInterval> | undefined;
  let cuPollTimer: ReturnType<typeof setInterval> | undefined;
  let cuDeadlineAt = 0;
  let cuWatchActive = false;
  let focusListening = false;
  let lastWebBridgeFocusRefreshAt = 0;
  let lastCuFocusRefreshAt = 0;

  const webBridgeRow = computed(() =>
    rows.value.find((row) => row.capability?.id === 'kimi-webbridge'),
  );
  const webBridgeDisconnected = computed(() =>
    webBridgeRow.value !== undefined && isWebBridgeExtensionDisconnected(webBridgeRow.value),
  );
  const webBridgeConnected = computed(() => {
    const row = webBridgeRow.value;
    if (row?.installedPlugin === undefined || row.capability?.supported !== true) return undefined;
    if (row.capability.install.running) return undefined;
    return row.capability.steps.find((step) => step.id === 'extension')?.state === 'ok';
  });
  const cuRow = computed(() => rows.value.find((row) => isKimiCuMacCapability(row)));
  const cuGranted = computed(() =>
    cuRow.value === undefined ? undefined : readKimiCuPermissions(cuRow.value).granted,
  );

  function clearGuidePoll(): void {
    if (guidePollTimer !== undefined) {
      clearInterval(guidePollTimer);
      guidePollTimer = undefined;
    }
  }

  function clearCuPoll(): void {
    if (cuPollTimer !== undefined) {
      clearInterval(cuPollTimer);
      cuPollTimer = undefined;
    }
  }

  function onWindowFocus(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (webBridgeDisconnected.value && now - lastWebBridgeFocusRefreshAt >= WEBBRIDGE_FOCUS_THROTTLE_MS) {
      lastWebBridgeFocusRefreshAt = now;
      void refreshCapability('kimi-webbridge');
    }
    if (cuWatchActive && now - lastCuFocusRefreshAt >= CU_FOCUS_THROTTLE_MS) {
      lastCuFocusRefreshAt = now;
      void pollCuPermissions();
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') onWindowFocus();
  }

  function syncFocusListeners(): void {
    if (typeof window === 'undefined') return;
    const shouldListen = webBridgeDisconnected.value || cuWatchActive;
    if (shouldListen && !focusListening) {
      window.addEventListener('focus', onWindowFocus);
      document.addEventListener('visibilitychange', onVisibilityChange);
      focusListening = true;
    } else if (!shouldListen && focusListening) {
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      focusListening = false;
    }
  }

  function finishCuPermissionWatch(): void {
    if (!cuWatchActive) return;
    cuWatchActive = false;
    clearCuPoll();
    cuPermissionWaiting.value = false;
    const snapshot = cuRow.value === undefined
      ? { accessibility: false, screenRecording: false, granted: false }
      : readKimiCuPermissions(cuRow.value);
    const result = snapshot.granted
      ? 'granted'
      : (snapshot.accessibility || snapshot.screenRecording)
        ? 'partial'
        : 'cancelled';
    track('cu_permission_result', {
      plugin_id: 'kimi-cu',
      accessibility_granted: snapshot.accessibility,
      screen_granted: snapshot.screenRecording,
      result,
    });
    syncFocusListeners();
  }

  async function pollCuPermissions(): Promise<void> {
    if (!cuWatchActive) return;
    await refreshCapability('kimi-cu');
    if (!cuWatchActive) return;
    const row = cuRow.value;
    if (row === undefined || readKimiCuPermissions(row).granted || Date.now() >= cuDeadlineAt) {
      finishCuPermissionWatch();
    }
  }

  function startCuPermissionWatch(entry: PluginGuideEntry): void {
    const row = cuRow.value;
    if (cuWatchActive || row === undefined || !isKimiCuMacCapability(row)) return;
    cuWatchActive = true;
    cuDeadlineAt = Date.now() + CU_PERMISSION_TIMEOUT_MS;
    cuPermissionWaiting.value = true;
    track('cu_permission_click', { plugin_id: 'kimi-cu', entry });
    clearCuPoll();
    cuPollTimer = setInterval(() => {
      void pollCuPermissions();
    }, GUIDE_POLL_INTERVAL_MS);
    syncFocusListeners();
  }

  async function requestCuPermissionsFromDetail(): Promise<void> {
    const row = cuRow.value;
    if (row === undefined || !isKimiCuMacCapability(row) || cuWatchActive) return;
    startCuPermissionWatch('detail');
    await requestCapabilityPermissions('kimi-cu');
    if (!cuWatchActive) return;
    const latest = cuRow.value;
    if (latest === undefined || readKimiCuPermissions(latest).granted || Date.now() >= cuDeadlineAt) {
      finishCuPermissionWatch();
    }
  }

  function openWebBridgeGuide(entry: PluginGuideEntry): void {
    if (!webBridgeDisconnected.value || webBridgeGuideOpen.value) return;
    if (guideFirstShownAt === null) guideFirstShownAt = Date.now();
    webBridgeGuideOpen.value = true;
    track('webbridge_guide_show', { plugin_id: 'kimi-webbridge', entry });
    void refreshCapability('kimi-webbridge');
  }

  function closeWebBridgeGuideLater(): void {
    if (!webBridgeGuideOpen.value) return;
    track('webbridge_guide_click', {
      plugin_id: 'kimi-webbridge',
      action: 'later',
      connected: webBridgeConnected.value === true,
    });
    webBridgeGuideOpen.value = false;
  }

  async function confirmWebBridgeGuideDone(): Promise<void> {
    if (!webBridgeGuideOpen.value || webBridgeChecking.value) return;
    webBridgeChecking.value = true;
    try {
      const status = await refreshCapability('kimi-webbridge');
      const connected = status !== undefined
        ? status.steps.some((step) => step.id === 'extension' && step.state === 'ok')
        : webBridgeConnected.value === true;
      track('webbridge_guide_click', { plugin_id: 'kimi-webbridge', action: 'done', connected });
      webBridgeGuideOpen.value = false;
    } finally {
      webBridgeChecking.value = false;
    }
  }

  function selectWebBridgeBrowser(browser: WebBridgeBrowser): void {
    track('webbridge_guide_click', {
      plugin_id: 'kimi-webbridge',
      action: browser,
      connected: webBridgeConnected.value === true,
    });
    window.open(WEBBRIDGE_EXTENSION_LINKS[browser].url, '_blank', 'noopener');
  }

  function onPluginInstalled(installedRow: PluginViewModel): void {
    const current = rows.value.find((row) => row.id === installedRow.id) ??
      rows.value.find((row) =>
        row.capability?.id !== undefined && row.capability.id === installedRow.capability?.id,
      );
    const target = current ?? installedRow;
    if (isWebBridgeExtensionDisconnected(target)) {
      openWebBridgeGuide('install');
      return;
    }
    if (isKimiCuPermissionMissing(target)) {
      startCuPermissionWatch('install');
    }
  }

  watch(webBridgeConnected, (next, previous) => {
    if (next === undefined || previous === undefined || next === previous) return;
    if (next) {
      const duration = guideFirstShownAt === null ? undefined : Math.max(0, Date.now() - guideFirstShownAt);
      track('webbridge_connect_result', {
        plugin_id: 'kimi-webbridge',
        connected: true,
        ...(duration === undefined ? {} : { duration_ms: Math.round(duration) }),
      });
      guideFirstShownAt = null;
    } else {
      track('webbridge_connect_result', { plugin_id: 'kimi-webbridge', connected: false });
    }
  });

  watch(cuGranted, (granted) => {
    if (cuWatchActive && granted === true) finishCuPermissionWatch();
  });

  watch([webBridgeGuideOpen, webBridgeDisconnected], ([open, disconnected]) => {
    if (open && disconnected) {
      if (guidePollTimer === undefined) {
        guidePollTimer = setInterval(() => {
          void refreshCapability('kimi-webbridge');
        }, GUIDE_POLL_INTERVAL_MS);
      }
    } else {
      clearGuidePoll();
    }
    syncFocusListeners();
  });

  onBeforeUnmount(() => {
    clearGuidePoll();
    clearCuPoll();
    cuWatchActive = false;
    if (focusListening && typeof window !== 'undefined') {
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      focusListening = false;
    }
  });

  return {
    webBridgeGuideOpen,
    webBridgeChecking,
    cuPermissionWaiting,
    onPluginInstalled,
    openWebBridgeGuide,
    closeWebBridgeGuideLater,
    confirmWebBridgeGuideDone,
    selectWebBridgeBrowser,
    requestCuPermissionsFromDetail,
  };
}
