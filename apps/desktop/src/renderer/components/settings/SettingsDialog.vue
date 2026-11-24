<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import type { AppSession } from '../../api/types';
import { serverEndpointLabel } from '../../api/config';
import { useDialogFocus } from '@moonshot-ai/app-components';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import LanguageSwitcher from './LanguageSwitcher.vue';
import { BrowserTabTitleSetting, FontSettingsPage, FontSettingsRow, useSettingsSubpage } from '@moonshot-ai/app-components';
import type { FontTarget } from '@moonshot-ai/app-core';
import ShortcutsPanel from './ShortcutsPanel.vue';
import type { ShortcutActionId } from '../../../shared/action-ids';
import { usePlugins } from '@moonshot-ai/app-client/composables';
import { PluginsPanel, ProvidersPanel, HostsPanel } from '@moonshot-ai/app-components';
import { canOpenInNative, listNativeOpenInApps, openInAppIcon, openTextFileInNative } from '../../lib/nativeOpenIn';
import { canPickWorkspaceDirectory, pickNativeFile } from '../../lib/nativeWorkspacePicker';
import { saveDefaultOpenInTarget, useDefaultOpenInTarget } from '@moonshot-ai/app-components';
import { canSetDockIconChoice, useDockIconChoice, type DockIconChoice } from '../../lib/dockIconChoice';
import {
  buildSecondaryModelPatch,
  commitLevel,
  defaultThinkingLevelFor,
  effortLabel,
  logWarn,
  modelThinkingAvailability,
  segmentsFor,
  thinkingLevelFromConfig,
  thinkingLevelToConfig,
} from '@moonshot-ai/app-core/lib';
import { track } from '../../lib/track';
import DockIconPicker from './DockIconPicker.vue';
import BrowserSettingsTab from '../browser/BrowserSettingsTab.vue';
import { copyTextToClipboard, hasDesktopBridge, isLinuxDesktop, isMacosDesktop, isRcLocation, prefersNativeTitleBar, providerDisplayName } from '@moonshot-ai/app-core/lib';
import { useContextInspector, useSessionMentions, useSidebarTabs } from '@moonshot-ai/app-core';
import { configStore, hostsStore } from '@moonshot-ai/app-client/stores';
import { useActivityRunFolding, usePasteImageAutoMention, useRunningSendMode, useTurnFolding, type RunningSendMode, type SettingsHighlightKey } from '@moonshot-ai/app-client';
import { useVibrancy } from '../../composables/useVibrancy';
import { usePreventSystemSleep } from '../../composables/usePreventSystemSleep';
import { useTerminalScreenReader } from '../../composables/useTerminalScreenReader';
import { isSleepPreventionMode } from '../../../shared/prevent-sleep';
import { downloadTraceLog, isTraceEnabled, setTraceEnabled } from '@moonshot-ai/app-client/trace';
import { useUpdateStatus, type UpdateCheckResult } from '@moonshot-ai/app-client/composables';
import type { ColorScheme, FontScale } from '@moonshot-ai/app-client/client';
import type { AppConfig, AppModel, ManagedQuotaResult, ManagedUserInfo, ThinkingLevel } from '../../api/types';
import PlanUsageCard from './PlanUsageCard.vue';
import { SecondaryModelPicker } from '@moonshot-ai/app-components';
import { PlanUpgradeCard } from '@moonshot-ai/app-components';
import { Badge, Button, Dialog, Icon, IconButton, SegmentedControl, Select, Switch } from '@moonshot-ai/app-ui';
import type { BrowserSettingsSection } from '../../../shared/browser-data';
import {
  visibleSettingsTabs,
  type SettingsTab,
} from '../../lib/settingsTabs';
import RemoteControlPanel from '../remote-control/RemoteControlPanel.vue';
import { useRemoteControl } from '../../composables/useRemoteControl';
import RuntimeEnvironmentDialog from './RuntimeEnvironmentDialog.vue';
import { createRuntimeEnvironmentVersionTrigger, runtimeEnvironmentBridge } from '../../lib/runtimeEnvironment';
import type { RuntimeEnvironmentOverrides } from '../../../shared/runtime-environment';

const { t } = useI18n();

const { vibrancy, setVibrancy } = useVibrancy();
const { preventSleepState, lidSleepStopped, setPreventSystemSleep, setPreventLidSleep } = usePreventSystemSleep();

const { sidebarTabs, setSidebarTabs } = useSidebarTabs();
const { contextInspectorEnabled, setContextInspectorEnabled } = useContextInspector();

const { turnFolding, setTurnFolding } = useTurnFolding();
const { activityRunFolding, setActivityRunFolding } = useActivityRunFolding();
const { pasteImageAutoMention, setPasteImageAutoMention } = usePasteImageAutoMention();
const { runningSendMode, setRunningSendMode } = useRunningSendMode();
const { terminalScreenReader, setTerminalScreenReader } = useTerminalScreenReader();

function onRunningSendModeChange(mode: RunningSendMode): void {
  setRunningSendMode(mode);
  track('settings_changed', { key: 'running-send-mode', value: mode, source_panel: 'settings' });
}

function onSidebarTabsChange(on: boolean): void {
  setSidebarTabs(on);
  track('settings_changed', { key: 'sidebar-multi-tab', value: on ? 'on' : 'off', source_panel: 'settings' });
}

const { sessionMentions, setSessionMentions } = useSessionMentions();

function onSessionMentionsChange(on: boolean): void {
  setSessionMentions(on);
  track('settings_changed', { key: 'session-mentions', value: on ? 'on' : 'off', source_panel: 'settings' });
}

function onContextInspectorChange(on: boolean): void {
  setContextInspectorEnabled(on);
  track('settings_changed', { key: 'context-inspector', value: on ? 'on' : 'off', source_panel: 'settings' });
}

const betaMasterState = computed(() => configStore().experimentalBeta);
const betaMasterEnabled = computed(() => betaMasterState.value?.enabled === true);
const betaMasterLockedByEnv = computed(() => betaMasterState.value?.source === 'env');

function findExperimentalFeature(id: string) {
  return configStore().experimentalFeatures.find((feature) => feature.id === id);
}

const notifyUserFeature = computed(() => findExperimentalFeature('notify_user'));
const notifyUserEnabled = computed(
  () => notifyUserFeature.value?.enabled ?? configStore().experimentalFlags['notify_user'] === true,
);
const notifyUserLockedByEnv = computed(() => notifyUserFeature.value?.source === 'env');
const notifyUserLocked = computed(() => notifyUserLockedByEnv.value || betaMasterEnabled.value);

const towerFeature = computed(() => findExperimentalFeature('tower'));
const towerToggleEnabled = computed(
  () => towerFeature.value?.enabled ?? configStore().experimentalFlags['tower'] === true,
);
const towerLockedByEnv = computed(() => towerFeature.value?.source === 'env');
const towerPendingRestart = computed(
  () => towerFeature.value !== undefined && towerFeature.value.enabled !== towerFeature.value.active,
);

async function onBetaMasterChange(on: boolean): Promise<void> {
  if (await configStore().setBetaFeaturesEnabled(on)) {
    track('settings_changed', { key: 'beta-features', value: on ? 'on' : 'off', source_panel: 'settings' });
  }
}

async function onNotifyUserChange(on: boolean): Promise<void> {
  if (await configStore().setNotifyUserEnabled(on)) {
    track('settings_changed', { key: 'notify-user', value: on ? 'on' : 'off', source_panel: 'settings' });
  }
}

async function onTowerChange(on: boolean): Promise<void> {
  if (await configStore().setExperimentalFlag('tower', on)) {
    track('settings_changed', { key: 'tower', value: on ? 'on' : 'off', source_panel: 'settings' });
  }
}

function onColorScheme(scheme: ColorScheme): void {
  emit('setColorScheme', scheme);
}

function onFontScale(scale: FontScale): void {
  emit('setFontScale', scale);
}

function onVibrancyChange(on: boolean): void {
  setVibrancy(on);
  track('settings_changed', { key: 'vibrancy', value: on ? 'on' : 'off', source_panel: 'settings' });
}

const preventSleepBusy = ref(false);
const preventSystemSleepFailed = ref(false);

async function onPreventSystemSleepChange(mode: string): Promise<void> {
  if (!isSleepPreventionMode(mode) || preventSleepBusy.value) return;
  preventSleepBusy.value = true;
  preventSystemSleepFailed.value = false;
  try {
    await setPreventSystemSleep(mode);
  } catch {
    preventSystemSleepFailed.value = true;
    return;
  } finally {
    preventSleepBusy.value = false;
  }
  track('settings_changed', { key: 'prevent-system-sleep', value: mode, source_panel: 'settings' });
}

const preventLidSleepFailed = ref(false);

const lidSettingsVisible = computed(() => preventSleepState.system !== 'allow-sleep');

const preventLidSleepHint = computed(() => {
  if (!preventSleepState.lidSupported) return t('settings.preventLidSleepUnsupported');
  if (preventLidSleepFailed.value || lidSleepStopped.value) return t('settings.preventLidSleepFailed');
  return t('settings.preventLidSleepDesc');
});

async function onPreventLidSleepChange(on: boolean): Promise<void> {
  if (preventSleepBusy.value) return;
  preventSleepBusy.value = true;
  preventLidSleepFailed.value = false;
  try {
    await setPreventLidSleep(on);
  } catch {
    preventLidSleepFailed.value = true;
    return;
  } finally {
    preventSleepBusy.value = false;
  }
  track('settings_changed', { key: 'prevent-lid-sleep', value: on ? 'on' : 'off', source_panel: 'settings' });
}

async function onPreventLidSleepRepair(): Promise<void> {
  if (preventSleepBusy.value) return;
  preventSleepBusy.value = true;
  preventLidSleepFailed.value = false;
  try {
    await setPreventLidSleep(preventSleepState.lid);
  } catch {
    preventLidSleepFailed.value = true;
  } finally {
    preventSleepBusy.value = false;
  }
}

const nativeTitleBar = ref(prefersNativeTitleBar);

function nativeTitleBarBridge():
  | { setLinuxNativeTitleBar?: (enabled: boolean) => Promise<{ status: string }> }
  | undefined {
  return (window as typeof window & { kimiDesktop?: { setLinuxNativeTitleBar?: (enabled: boolean) => Promise<{ status: string }> } })
    .kimiDesktop;
}

async function onNativeTitleBarChange(on: boolean): Promise<void> {
  const bridge = nativeTitleBarBridge();
  if (on === nativeTitleBar.value || !bridge?.setLinuxNativeTitleBar) return;
  const ok = await confirm({
    title: t('settings.nativeTitleBarRestartTitle'),
    message: t('settings.nativeTitleBarRestartMessage'),
    confirmLabel: t('settings.nativeTitleBarRestartConfirm'),
  });
  if (!ok) return;
  const result = await bridge.setLinuxNativeTitleBar(on);
  if (result.status !== 'relaunching') return;
  nativeTitleBar.value = on;
  track('settings_changed', { key: 'native-title-bar', value: on ? 'on' : 'off', source_panel: 'settings' });
}

function onNotifyChange(on: boolean): void {
  emit('setNotify', on);
  track('settings_changed', { key: 'notifications', value: on ? 'on' : 'off', source_panel: 'settings' });
}

const props = defineProps<{
  colorScheme: ColorScheme;
  fontScale: FontScale;
  managedProviderStatus?: string | null;
  managedUserInfo?: ManagedUserInfo | null;
  onFetchUsage: () => Promise<ManagedQuotaResult>;
  notify: boolean;
  notifyPermission?: string;
  notifySound: boolean;
  config?: AppConfig | null;
  models?: AppModel[];
  configSaving?: boolean;
  /** Tab to open on (default 'general'); deep links like the onboarding
      custom-provider entry land on 'providers'. Read once at mount. */
  initialTab?: SettingsTab;
  highlightKey?: SettingsHighlightKey;
  initialBrowserSection?: BrowserSettingsSection;
  initialShortcutAction?: ShortcutActionId;
  serverVersion?: string;
}>();

const emit = defineEmits<{
  setColorScheme: [colorScheme: ColorScheme];
  setFontScale: [scale: FontScale];
  setNotify: [on: boolean];
  setNotifySound: [on: boolean];
  login: [];
  logout: [];
  updateConfig: [patch: Partial<AppConfig>];
  openBrowserUrl: [url: string];
  createProject: [hostId: string];
  close: [];
}>();

const signedIn = computed(() => props.managedProviderStatus === 'authenticated');
const rcMode = isRcLocation(window.location);

const accountName = computed(() => {
  if (!signedIn.value) return t('sidebar.notSignedIn');
  return props.managedUserInfo?.nickname || t('sidebar.defaultUserName');
});

const accountLevel = computed(() => props.managedUserInfo?.userLevelName?.trim() ?? '');

const avatarLoadFailed = ref(false);
watch(
  () => props.managedUserInfo?.avatar,
  () => {
    avatarLoadFailed.value = false;
  },
);
const showAvatar = computed(() => Boolean(props.managedUserInfo?.avatar) && !avatarLoadFailed.value);

const accountSubtitle = computed(() =>
  signedIn.value ? t('settings.signedIn') : t('settings.signedOutHint'),
);

const activeTab = ref<SettingsTab>(
  props.initialTab ?? (props.highlightKey === 'running-send-mode' ? 'agent' : 'general'),
);
const runningSendRowRef = ref<HTMLElement | null>(null);
const highlightedSetting = ref<SettingsHighlightKey | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function clearHighlightTimer(): void {
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function triggerSettingHighlight(key: SettingsHighlightKey | undefined): void {
  clearHighlightTimer();
  if (!key) {
    highlightedSetting.value = null;
    return;
  }
  if (key === 'running-send-mode' && activeTab.value !== 'agent') {
    activeTab.value = 'agent';
  }
  highlightedSetting.value = key;
  void nextTick(() => {
    const el = key === 'running-send-mode' ? runningSendRowRef.value : null;
    el?.scrollIntoView?.({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  });
  highlightTimer = setTimeout(() => {
    highlightedSetting.value = null;
    highlightTimer = null;
  }, 2200);
}

watch(
  () => props.highlightKey,
  (key) => {
    triggerSettingHighlight(key);
  },
);

const bodyScrolling = ref(false);
let bodyScrollHideTimer: ReturnType<typeof setTimeout> | null = null;

function onBodyScroll(): void {
  bodyScrolling.value = true;
  if (bodyScrollHideTimer) clearTimeout(bodyScrollHideTimer);
  bodyScrollHideTimer = setTimeout(() => {
    bodyScrolling.value = false;
    bodyScrollHideTimer = null;
  }, 900);
}

const { state: pluginsState, probeSupport: probePluginSupport } = usePlugins();
const remoteControl = useRemoteControl();
onMounted(() => {
  void probePluginSupport();
});
const desktopBridge = hasDesktopBridge();
const visibleTabs = computed(() => visibleSettingsTabs(desktopBridge, pluginsState.unsupported));
watch(
  () => pluginsState.unsupported,
  (unsupported) => {
    if (unsupported && activeTab.value === 'plugins') activeTab.value = 'general';
  },
);

const USER_AGREEMENT_URL = 'https://www.kimi.com/user/agreement/modelUse?version=v2';
const PRIVACY_POLICY_URL = 'https://www.kimi.com/user/agreement/userPrivacy?version=v2';

function openAgreement(url: string): void {
  window.open(url, '_blank', 'noopener');
}
const permissionModes = ['manual', 'yolo', 'auto'] as const;
const permissionLabelKey: Record<(typeof permissionModes)[number], string> = {
  manual: 'status.permissionManual',
  auto: 'status.permissionAuto',
  yolo: 'status.permissionYolo',
};

const dialogRef = ref<HTMLElement | null>(null);
useDialogFocus(dialogRef);

const { isConfirmOpen, confirm } = useConfirmDialog();

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.defaultPrevented && !isConfirmOpen.value && !remoteControl.conflictDialogOpen.value && !runtimeEnvironmentOpen.value) {
    e.stopPropagation();
    emit('close');
  }
}
onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  if (props.highlightKey) triggerSettingHighlight(props.highlightKey);
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  if (bodyScrollHideTimer) clearTimeout(bodyScrollHideTimer);
  clearHighlightTimer();
});

const openInAppOptions = ref<Array<{ value: string; label: string; icon?: string }> | null>(null);
const defaultOpenInApp = useDefaultOpenInTarget();

function onDefaultOpenInChange(appId: string): void {
  saveDefaultOpenInTarget(appId);
  track('settings_changed', { key: 'open-in-default', value: appId === '' ? 'auto' : appId, source_panel: 'settings' });
}

const openInSelectValue = computed(() => {
  const options = openInAppOptions.value ?? [];
  const current = defaultOpenInApp.value;
  return current !== null && options.some((o) => o.value === current)
    ? current
    : (options[0]?.value ?? '');
});

onMounted(async () => {
  if (!canOpenInNative()) return;
  const apps = await listNativeOpenInApps();
  if (apps.length === 0) return;
  openInAppOptions.value = apps.map((app) => ({
    value: app.id,
    label: app.label,
    icon: openInAppIcon(app.id) || undefined,
  }));
});

const dockIconChoice = useDockIconChoice();
const showDockIconRow = isMacosDesktop && canSetDockIconChoice();

function onDockIconChange(value: DockIconChoice): void {
  dockIconChoice.value = value;
  track('settings_changed', { key: 'dock-icon', value, source_panel: 'settings' });
}

function exportLog(): void {
  downloadTraceLog();
}

const appVersionText =
  typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
    ? __KIMI_CLIENT_VERSION__
    : '-';

const runtimeEnvironmentOpen = ref(false);
const runtimeEnvironmentOverrides = ref<RuntimeEnvironmentOverrides>({});

async function openRuntimeEnvironment(): Promise<void> {
  const bridge = runtimeEnvironmentBridge();
  if (bridge?.getRuntimeEnvironmentOverrides === undefined) return;
  try {
    const result = await bridge.getRuntimeEnvironmentOverrides();
    if (result.status === 'ok') {
      runtimeEnvironmentOverrides.value = result.overrides;
      runtimeEnvironmentOpen.value = true;
    } else if (result.status === 'error') {
      await confirm({
        title: t('settings.runtimeEnvironmentTitle'),
        message: t('settings.runtimeEnvironmentLoadFailed'),
        confirmLabel: t('common.close'),
        variant: 'primary',
      });
    }
  } catch {
    await confirm({
      title: t('settings.runtimeEnvironmentTitle'),
      message: t('settings.runtimeEnvironmentLoadFailed'),
      confirmLabel: t('common.close'),
      variant: 'primary',
    });
  }
}

const onAppVersionClick = createRuntimeEnvironmentVersionTrigger(openRuntimeEnvironment);

const coreRefText =
  typeof __KIMI_CORE_REF__ === 'string' && __KIMI_CORE_REF__.trim() ? __KIMI_CORE_REF__ : '-';

const daemonEndpoint = serverEndpointLabel();
const copiedServerVersion = ref(false);
const copiedServerAddress = ref(false);

function copyServerVersion(): void {
  if (!props.serverVersion) return;
  void copyTextToClipboard(props.serverVersion).then((ok) => {
    if (!ok) return;
    copiedServerVersion.value = true;
    setTimeout(() => { copiedServerVersion.value = false; }, 1500);
  });
}

function copyServerAddress(): void {
  void copyTextToClipboard(daemonEndpoint).then((ok) => {
    if (!ok) return;
    copiedServerAddress.value = true;
    setTimeout(() => { copiedServerAddress.value = false; }, 1500);
  });
}

const updateTracker = useUpdateStatus();
const checkingUpdate = ref(false);
const checkResult = ref<UpdateCheckResult | null>(null);

function onAutoDownloadChange(on: boolean): void {
  updateTracker.setAutoDownload(on, 'settings');
}

async function onCheckUpdate(): Promise<void> {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  checkResult.value = null;
  try {
    checkResult.value = await updateTracker.check();
  } finally {
    checkingUpdate.value = false;
  }
}

const checkResultText = computed(() => {
  const result = checkResult.value;
  if (result === null) return '';
  switch (result.outcome) {
    case 'available':
      if (updateTracker.status.value.state === 'downloaded') {
        return t('settings.updateCheckDownloaded', { version: result.version ?? '' });
      }
      if (updateTracker.autoDownload.value) {
        return t('settings.updateCheckAvailableAuto', { version: result.version ?? '' });
      }
      return t('settings.updateCheckAvailable', { version: result.version ?? '' });
    case 'latest':
      return t('settings.updateCheckLatest');
    case 'unsupported':
      return t('settings.updateCheckUnsupported');
    case 'error':
      return t('settings.updateCheckFailed');
  }
});

type ModelOption = { id: string; label: string; provider: string };

const modelOptions = computed<ModelOption[]>(() => {
  const byId = new Map<string, ModelOption>();
  for (const model of props.models ?? []) {
    byId.set(model.id, {
      id: model.id,
      label: model.displayName ?? model.model ?? model.id,
      provider: model.provider,
    });
  }
  for (const [id, raw] of Object.entries(props.config?.models ?? {})) {
    if (byId.has(id)) continue;
    const provider = extractConfigModelProvider(raw);
    byId.set(id, {
      id,
      label: formatConfigModelLabel(id, raw, provider),
      provider: provider ?? id,
    });
  }
  return Array.from(byId.values());
});

const modelGroups = computed<Array<{ provider: string; options: ModelOption[] }>>(() => {
  const map = new Map<string, ModelOption[]>();
  for (const option of modelOptions.value) {
    const list = map.get(option.provider) ?? [];
    list.push(option);
    map.set(option.provider, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return Array.from(map.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, options]) => ({ provider, options }));
});

const defaultModelSelectOptions = computed(() => {
  const options: Array<{ value: string; label: string; group?: string; disabled?: boolean }> = modelGroups.value.flatMap((group) =>
    group.options.map((model) => ({ value: model.id, label: model.label, group: providerDisplayName(group.provider, t) })),
  );
  if (!props.config?.defaultModel) {
    options.unshift({ value: '', label: t('settings.noDefaultModel'), group: '', disabled: true });
  }
  return options;
});

const defaultPermissionMode = computed(() => {
  const mode = props.config?.defaultPermissionMode;
  return mode === 'auto' || mode === 'yolo' || mode === 'manual' ? mode : 'manual';
});

function extractConfigModelProvider(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const provider = typeof source['provider'] === 'string' ? source['provider'] : undefined;
  return provider;
}

function formatConfigModelLabel(id: string, raw: unknown, provider?: string): string {
  if (!raw || typeof raw !== 'object') return id;
  const source = raw as Record<string, unknown>;
  const model = typeof source['model'] === 'string' ? source['model'] : undefined;
  const resolvedProvider = provider ?? extractConfigModelProvider(raw);
  if (model && resolvedProvider) return `${id} (${providerDisplayName(resolvedProvider, t)}/${model})`;
  if (model) return `${id} (${model})`;
  return id;
}

function configBool(value: boolean | undefined): boolean {
  return value === true;
}

function setDefaultModel(value: string): void {
  if (!value || value === props.config?.defaultModel) return;
  emit('updateConfig', { defaultModel: value });
}

function setDefaultPermissionMode(mode: 'manual' | 'auto' | 'yolo'): void {
  if (mode === defaultPermissionMode.value) return;
  emit('updateConfig', { defaultPermissionMode: mode });
}

const secondaryModel = computed(
  () => props.config?.secondaryModel?.defaultModel ?? props.config?.secondaryModel?.model ?? '',
);
const secondaryModelEffort = computed(() => props.config?.secondaryModel?.defaultEffort ?? '');

const modelInfoById = computed(() =>
  Object.fromEntries((props.models ?? []).map((model) => [model.id, model])),
);

async function setSecondaryModel(value: { model: string | null; effort?: string }): Promise<void> {
  const model = value.model;
  if (model === null) {
    const current = props.config?.secondaryModel;
    if (!current) return;
    if (Object.keys(current.models ?? {}).length > 0) {
      const confirmed = await confirm({
        title: t('settings.secondaryModelClearPoolTitle'),
        message: t('settings.secondaryModelClearPoolMessage'),
        confirmLabel: t('settings.secondaryModelClearPoolConfirm'),
      });
      if (!confirmed) return;
    }
    emit('updateConfig', { secondaryModel: null });
    return;
  }
  if (model === secondaryModel.value && (value.effort ?? '') === secondaryModelEffort.value) {
    return;
  }
  emit('updateConfig', {
    secondaryModel: buildSecondaryModelPatch(props.config?.secondaryModel, { ...value, model }),
  });
}

function toggleConfigBoolean(key: 'defaultPlanMode'): void {
  const current = props.config?.[key];
  emit('updateConfig', { [key]: !configBool(current) } as Partial<AppConfig>);
}

const defaultModelInfo = computed(() =>
  props.config?.defaultModel ? modelInfoById.value[props.config.defaultModel] : undefined,
);
const defaultThinkingAvailability = computed(() => modelThinkingAvailability(defaultModelInfo.value));
const defaultThinkingSegments = computed(() => segmentsFor(defaultModelInfo.value));

function defaultThinkingLevel(): ThinkingLevel {
  return (
    thinkingLevelFromConfig(props.config?.thinking, defaultModelInfo.value) ??
    defaultThinkingLevelFor(defaultModelInfo.value)
  );
}

const activeDefaultThinkingSegment = computed(() => {
  const segs = defaultThinkingSegments.value;
  const level = defaultThinkingLevel();
  return segs.includes(level) ? level : '';
});

const defaultThinkingOptions = computed(() =>
  defaultThinkingSegments.value.map((seg) => ({ value: seg, label: effortLabel(seg) })),
);

function setDefaultThinkingSegment(draft: string): void {
  const level = commitLevel(defaultModelInfo.value, draft);
  emit('updateConfig', {
    thinking: thinkingLevelToConfig(level),
  } as Partial<AppConfig>);
}

function toggleTelemetry(): void {
  const enabled = props.config?.telemetry !== false;
  track('telemetry_consent_changed', { enabled: !enabled });
  emit('updateConfig', { telemetry: !enabled } as Partial<AppConfig>);
}

function setSessionRatingPrompts(enabled: boolean): void {
  emit('updateConfig', { disableFeedbackSurvey: !enabled } as Partial<AppConfig>);
}

function toggleAutoSessionTitle(): void {
  const enabled = props.config?.autoSessionTitle !== false;
  emit('updateConfig', { autoSessionTitle: !enabled } as Partial<AppConfig>);
}

function setTab(tab: SettingsTab): void {
  if (tab !== activeTab.value) {
    clearHighlightTimer();
    highlightedSetting.value = null;
  }
  activeTab.value = tab;
}

const bodyRef = ref<HTMLElement | null>(null);
const fontPage = useSettingsSubpage<FontTarget>(() => bodyRef.value);
const fontPageTarget = fontPage.page;
watch(activeTab, () => fontPage.reset());

const client = useKimiWebClient();

const showPlanUpgrade = computed(() => signedIn.value && client.managedMembership.value === 'free');

const archivedItems = ref<AppSession[]>([]);
const archivedLoading = ref(false);
const archivedLoaded = ref(false);
const archiveQuery = ref('');
const archiveWsFilter = ref<string>('all');
const archiveSort = ref<'archived-desc' | 'created-desc' | 'name-asc'>('archived-desc');

async function loadAllArchived(): Promise<void> {
  if (archivedLoading.value || archivedLoaded.value) return;
  archivedLoading.value = true;
  try {
    archivedItems.value = await client.loadArchivedSessions();
    archivedLoaded.value = true;
  } catch (err) {
    logWarn('loadAllArchived failed', err);
  } finally {
    archivedLoading.value = false;
  }
}

watch(
  activeTab,
  (tab) => {
    if (tab === 'archived' && !archivedLoaded.value) {
      void loadAllArchived();
    }
  },
  { immediate: true },
);

const archiveWorkspaces = computed<string[]>(() => {
  const set = new Set<string>();
  for (const s of archivedItems.value) set.add(s.cwd);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});
const archiveWorkspaceSelectOptions = computed(() => [
  { value: 'all', label: t('settings.archivedAllWorkspaces') },
  ...archiveWorkspaces.value.map((workspace) => ({ value: workspace, label: workspace })),
]);

const filteredArchived = computed<AppSession[]>(() => {
  const q = archiveQuery.value.trim().toLowerCase();
  let rows = archivedItems.value.filter((s) => s.archived === true && !client.isSessionDeleted(s.id));
  if (archiveWsFilter.value !== 'all') {
    rows = rows.filter((s) => s.cwd === archiveWsFilter.value);
  }
  if (q) rows = rows.filter((s) => s.title.toLowerCase().includes(q));
  rows = rows.slice();
  if (archiveSort.value === 'archived-desc') {
    rows.sort((a, b) =>
      (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt),
    );
  } else if (archiveSort.value === 'created-desc') {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  return rows;
});

const groupedArchived = computed<{ cwd: string; items: AppSession[] }[]>(() => {
  const map = new Map<string, AppSession[]>();
  for (const s of filteredArchived.value) {
    const list = map.get(s.cwd) ?? [];
    list.push(s);
    map.set(s.cwd, list);
  }
  return Array.from(map.entries()).map(([cwd, items]) => ({ cwd, items }));
});

async function onRestore(id: string): Promise<void> {
  const ok = await client.restoreSession(id);
  if (ok) {
    archivedItems.value = archivedItems.value.filter((s) => s.id !== id);
  }
}

async function onDeleteArchived(s: AppSession): Promise<void> {
  await client.deleteSessionWithToast(s.id, { title: s.title });
  if (client.isSessionDeleted(s.id)) {
    archivedItems.value = archivedItems.value.filter((x) => x.id !== s.id);
  }
}

function archiveTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <Dialog :open="true" :close-on-esc="false" forward-esc :aria-label="t('settings.title')" size="xl" height="fixed" :panel-class="'settings-dialog'" :panel-style="fontPage.fitHeight.value === null ? undefined : { height: `${fontPage.fitHeight.value}px` }" :padded="false" level="grouped" @close="emit('close')">
    <div ref="dialogRef" class="sd">
      <nav class="settings-tabs" role="tablist" :aria-label="t('settings.title')">
        <header class="settings-tabs-header">
          <h2 class="settings-dialog-title">{{ t('settings.title') }}</h2>
        </header>
        <div class="settings-tab-list">
          <button
            v-for="tb in visibleTabs"
            :key="tb.id"
            type="button"
            class="tab"
            role="tab"
            :aria-selected="activeTab === tb.id"
            :class="{ on: activeTab === tb.id }"
            @click="setTab(tb.id)"
          >
            <Icon :name="tb.icon" size="md" />
            <span>{{ t(tb.labelKey) }}</span>
          </button>
        </div>
      </nav>

      <section class="settings-region">
        <header class="settings-region-header">
          <IconButton size="sm" :label="t('settings.close')" :tooltip="t('settings.close')" @click="emit('close')">
            <Icon name="close" size="md" />
          </IconButton>
        </header>
        <div ref="bodyRef" class="body" :class="{ scrolling: bodyScrolling }" @scroll="onBodyScroll">
        <section v-show="activeTab === 'general'" class="panel">
          <FontSettingsPage v-if="fontPageTarget" :key="fontPageTarget" :target="fontPageTarget" @back="fontPage.back()" />
          <div v-show="!fontPageTarget" class="panel-sections">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.appearance') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('theme.colorSchemeLabel') }}
                <span class="hint">{{ t('settings.colorSchemeHint') }}</span>
              </span>
              <SegmentedControl
                :model-value="colorScheme"
                :options="[
                  { value: 'light', label: t('theme.light'), icon: 'light-mode' },
                  { value: 'dark', label: t('theme.dark'), icon: 'dark-mode' },
                  { value: 'system', label: t('theme.system') },
                ]"
                @update:model-value="onColorScheme($event as ColorScheme)"
              />
            </div>
            <div class="row language-row">
              <span class="rlabel">
                {{ t('sidebar.language') }}
                <span class="hint">{{ t('settings.languageHint') }}</span>
              </span>
              <LanguageSwitcher />
            </div>
            <BrowserTabTitleSetting v-if="!desktopBridge" source-panel="settings" />
            <div v-if="isMacosDesktop" class="row">
              <span class="rlabel">
                {{ t('settings.vibrancy') }}
                <span class="hint">{{ t('settings.vibrancyHint') }}</span>
              </span>
              <Switch
                :model-value="vibrancy"
                :label="t('settings.vibrancy')"
                @update:model-value="onVibrancyChange"
              />
            </div>
            <div v-if="isLinuxDesktop" class="row">
              <span class="rlabel">
                {{ t('settings.nativeTitleBar') }}
                <span class="hint">{{ t('settings.nativeTitleBarHint') }}</span>
              </span>
              <Switch
                :model-value="nativeTitleBar"
                :label="t('settings.nativeTitleBar')"
                @update:model-value="onNativeTitleBarChange"
              />
            </div>
            <div v-if="showDockIconRow" class="row">
              <span class="rlabel">
                {{ t('settings.appIcon') }}
                <span class="hint">{{ t('settings.appIconHint') }}</span>
              </span>
              <DockIconPicker :model-value="dockIconChoice" @update:model-value="onDockIconChange" />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.sidebarTabs') }}
                <span class="hint">{{ t('settings.sidebarTabsHint') }}</span>
              </span>
              <Switch
                :model-value="sidebarTabs"
                :label="t('settings.sidebarTabs')"
                @update:model-value="onSidebarTabsChange"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.fonts') }}</h3>
            <div class="settings-group">
            <div class="row font-size-row">
              <span class="rlabel">
                {{ t('settings.uiFontSize') }}
                <span class="hint">{{ t('settings.uiFontSizeHint') }}</span>
              </span>
              <SegmentedControl
                :model-value="fontScale"
                :options="[
                  { value: 'small', label: t('settings.uiFontSizeSmall') },
                  { value: 'medium', label: t('settings.uiFontSizeMedium') },
                  { value: 'large', label: t('settings.uiFontSizeLarge') },
                  { value: 'xlarge', label: t('settings.uiFontSizeXlarge') },
                ]"
                :aria-label="t('settings.uiFontSize')"
                @update:model-value="onFontScale($event as FontScale)"
              />
            </div>
            <FontSettingsRow target="ui" @open="fontPage.open" />
            <FontSettingsRow target="transcript" @open="fontPage.open" />
            <FontSettingsRow target="code" @open="fontPage.open" />
            <FontSettingsRow v-if="desktopBridge" target="terminal" @open="fontPage.open" />
            </div>
          </section>

          <section v-if="desktopBridge" class="sec">
            <h3 class="sec-title">{{ t('settings.sleep') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.preventSystemSleep') }}
                <span class="hint">{{ t('settings.preventSystemSleepDesc') }}</span>
                <span v-if="preventSystemSleepFailed" class="hint" role="alert">{{ t('settings.preventSystemSleepFailed') }}</span>
              </span>
              <div class="select-wrap">
                <Select
                  :model-value="preventSleepState.system"
                  :aria-label="t('settings.preventSystemSleep')"
                  :disabled="preventSleepBusy"
                  :options="[
                    { value: 'allow-sleep', label: t('settings.sleepModeAllow'), description: t('settings.sleepModeAllowDesc') },
                    { value: 'prevent-app-suspension', label: t('settings.sleepModeSystem'), description: t('settings.sleepModeSystemDesc') },
                    { value: 'prevent-display-sleep', label: t('settings.sleepModeDisplay'), description: t('settings.sleepModeDisplayDesc') },
                  ]"
                  @update:model-value="onPreventSystemSleepChange"
                />
              </div>
            </div>
            <div v-if="lidSettingsVisible" class="row">
              <span class="rlabel">
                {{ t('settings.preventLidSleep') }}
                <span class="hint">{{ preventLidSleepHint }}</span>
              </span>
              <Switch
                :model-value="preventSleepState.lid"
                :label="t('settings.preventLidSleep')"
                :disabled="!preventSleepState.lidSupported || preventSleepBusy"
                @update:model-value="onPreventLidSleepChange"
              />
            </div>
            <div v-if="lidSettingsVisible && preventSleepState.lidNeedsRepair" class="row">
              <span class="rlabel">
                <span class="hint">{{ t('settings.preventLidSleepNeedsRepair') }}</span>
              </span>
              <Button variant="secondary" size="sm" :disabled="preventSleepBusy" @click="onPreventLidSleepRepair">
                {{ t('settings.preventLidSleepRepair') }}
              </Button>
            </div>
            </div>
          </section>

          <section class="sec notification-settings">
            <h3 class="sec-title">{{ t('settings.notifications') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.notifyEnabled') }}
                <span class="hint">{{ t('settings.notifyEnabledHint') }}</span>
                <span v-if="notifyPermission === 'denied'" class="hint">{{ t('settings.notifyDenied') }}</span>
              </span>
              <Switch
                :model-value="notify"
                :disabled="notifyPermission === 'denied'"
                :label="t('settings.notifyEnabled')"
                @update:model-value="onNotifyChange"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.notifySound') }}
                <span class="hint">{{ t('settings.notifySoundHint') }}</span>
              </span>
              <Switch
                :model-value="notifySound"
                :label="t('settings.notifySound')"
                @update:model-value="emit('setNotifySound', $event)"
              />
            </div>
            </div>
          </section>

          <section v-if="openInAppOptions" class="sec">
            <h3 class="sec-title">{{ t('settings.openWith') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.defaultOpenInApp') }}
                <span class="hint">{{ t('settings.defaultOpenInAppHint') }}</span>
              </span>
              <div class="select-wrap">
                <Select
                  :model-value="openInSelectValue"
                  :options="openInAppOptions"
                  :aria-label="t('settings.defaultOpenInApp')"
                  @update:model-value="onDefaultOpenInChange"
                />
              </div>
            </div>
            </div>
          </section>

          <section v-if="config" class="sec">
            <h3 class="sec-title">{{ t('settings.privacy') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.telemetry') }}
                <span class="hint">{{ t('settings.telemetryHint') }}</span>
              </span>
              <Switch
                :model-value="config.telemetry !== false"
                :disabled="configSaving"
                :label="t('settings.telemetry')"
                @update:model-value="toggleTelemetry()"
              />
            </div>
            <div v-if="desktopBridge" class="row">
              <span class="rlabel">
                {{ t('settings.sessionRatingPrompts') }}
                <span class="hint">{{ t('settings.sessionRatingPromptsHint') }}</span>
              </span>
              <Switch
                :model-value="config.disableFeedbackSurvey !== true"
                :disabled="configSaving"
                :label="t('settings.sessionRatingPrompts')"
                @update:model-value="setSessionRatingPrompts"
              />
            </div>
            </div>
          </section>
          </div>
        </section>
        <section v-if="activeTab === 'hosts'" class="panel">
          <HostsPanel
            :open-ssh-config="canOpenInNative() ? (path: string) => void openTextFileInNative(path) : undefined"
            :pick-identity-file="canPickWorkspaceDirectory() ? (defaultPath?: string) => pickNativeFile({ title: t('settings.hosts.identityLabel'), defaultPath }) : undefined"
            :create-project="(hostId) => emit('createProject', hostId)"
          />
        </section>

        <section v-if="activeTab === 'remoteControl'" class="panel">
          <RemoteControlPanel
            :controller="remoteControl"
            :signed-in="signedIn"
            @login="emit('login')"
          />
        </section>

        <section v-if="activeTab === 'browser'" class="panel">
          <BrowserSettingsTab
            :initial-section="initialBrowserSection"
            @open-url="emit('openBrowserUrl', $event)"
          />
        </section>

        <section v-show="activeTab === 'account'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.account') }}</h3>
            <div class="settings-group">
            <div class="account-row">
              <span class="account-avatar" aria-hidden="true">
                <img v-if="showAvatar" :src="props.managedUserInfo?.avatar" alt="" @error="avatarLoadFailed = true" />
                <Icon v-else name="user" size="md" />
              </span>
              <span class="account-meta">
                <span class="account-name-row">
                  <span class="account-name">{{ accountName }}</span>
                  <Badge v-if="accountLevel" class="account-level" variant="neutral" size="sm">{{ accountLevel }}</Badge>
                </span>
                <span class="account-sub">{{ accountSubtitle }}</span>
              </span>
              <Button v-if="signedIn && !rcMode" variant="danger" size="sm" @click="emit('logout')">{{ t('sidebar.signOut') }}</Button>
              <Button v-else-if="!signedIn" variant="primary" size="sm" @click="emit('login')">{{ t('sidebar.signIn') }}</Button>
            </div>
            </div>
          </section>
          <PlanUpgradeCard v-if="showPlanUpgrade" />
          <PlanUsageCard
            v-else-if="signedIn"
            :on-fetch-usage="props.onFetchUsage"
            :active="activeTab === 'account'"
          />
        </section>

        <section v-show="activeTab === 'agent'" class="panel">
          <section class="sec">
            <div class="sec-head">
              <h3 class="sec-title">{{ t('settings.agentDefaults') }}</h3>
            </div>

            <div class="settings-group">
            <template v-if="config">
              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultModel') }}
                  <span class="hint">{{ t('settings.defaultModelHint') }}</span>
                </span>
                <div v-if="modelGroups.length > 0" class="select-wrap">
                  <Select
                    :model-value="config.defaultModel ?? ''"
                    :options="defaultModelSelectOptions"
                    :aria-label="t('settings.defaultModel')"
                    @update:model-value="setDefaultModel"
                  />
                </div>
                <span v-else class="rvalue mono">{{ config.defaultModel ?? t('settings.noDefaultModel') }}</span>
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultPermission') }}
                  <span class="hint">{{ t('settings.defaultPermissionHint') }}</span>
                </span>
                <SegmentedControl
                  :model-value="defaultPermissionMode"
                  :options="permissionModes.map((m) => ({ value: m, label: t(permissionLabelKey[m]) }))"
                  @update:model-value="setDefaultPermissionMode($event as 'manual' | 'auto' | 'yolo')"
                />
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultThinking') }}
                  <span class="hint">{{ t('settings.defaultThinkingHint') }}</span>
                </span>
                <span
                  v-if="!config.defaultModel"
                  class="rvalue mono"
                >{{ t('settings.noDefaultModel') }}</span>
                <span
                  v-else-if="defaultThinkingAvailability === 'unsupported'"
                  class="rvalue mono"
                >{{ t('status.modeNotSupported') }}</span>
                <SegmentedControl
                  v-else-if="defaultThinkingSegments.length > 1"
                  :model-value="activeDefaultThinkingSegment"
                  :options="defaultThinkingOptions"
                  :aria-label="t('settings.defaultThinking')"
                  @update:model-value="setDefaultThinkingSegment"
                />
                <span v-else class="rvalue mono">{{ effortLabel(defaultThinkingSegments[0] ?? 'on') }}</span>
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultPlanMode') }}
                  <span class="hint">{{ t('settings.defaultPlanModeHint') }}</span>
                </span>
                <Switch
                  :model-value="configBool(config.defaultPlanMode)"
                  :label="t('settings.defaultPlanMode')"
                  @update:model-value="toggleConfigBoolean('defaultPlanMode')"
                />
              </div>
            </template>

            <div v-else class="empty-config">
              {{ t('settings.configUnavailable') }}
            </div>
            </div>
          </section>

          <section v-if="config" class="sec">
            <div class="sec-head">
              <h3 class="sec-title">{{ t('settings.secondaryModelSection') }}</h3>
            </div>

            <div class="settings-group">
              <div class="row">
                <span class="rlabel">
                  {{ t('settings.secondaryModel') }}
                  <span class="hint">{{ t(hostsStore().hosts.length > 0 ? 'settings.secondaryModelHintLocalOnly' : 'settings.secondaryModelHint') }}</span>
                </span>
                <div v-if="modelGroups.length > 0" class="select-wrap">
                  <SecondaryModelPicker
                    :model-value="secondaryModel"
                    :effort="secondaryModelEffort"
                    :groups="modelGroups"
                    :model-info-by-id="modelInfoById"
                    @select="setSecondaryModel"
                  />
                </div>
                <span v-else class="rvalue mono">{{ secondaryModel || t('settings.noSecondaryModel') }}</span>
              </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.composerSection') }}</h3>
            <div class="settings-group">
            <div
              ref="runningSendRowRef"
              class="row"
              :class="{ 'row-highlighted': highlightedSetting === 'running-send-mode' }"
              :data-setting-highlighted="highlightedSetting === 'running-send-mode' ? 'true' : undefined"
            >
              <span class="rlabel">
                {{ t('settings.runningSendMode') }}
                <span class="hint">{{ t('settings.runningSendModeHint') }}</span>
              </span>
              <SegmentedControl
                :model-value="runningSendMode"
                :options="[
                  { value: 'steer', label: t('settings.runningSendSteer') },
                  { value: 'queue', label: t('settings.runningSendQueue') },
                ]"
                :aria-label="t('settings.runningSendMode')"
                @update:model-value="onRunningSendModeChange($event as RunningSendMode)"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.pasteImageAutoMention') }}
                <span class="hint">{{ t('settings.pasteImageAutoMentionHint') }}</span>
              </span>
              <Switch
                :model-value="pasteImageAutoMention"
                :label="t('settings.pasteImageAutoMention')"
                @update:model-value="setPasteImageAutoMention"
              />
            </div>
            </div>
          </section>

          <!-- 消息折叠：两个独立开关，各管一个折叠层级。消息自动折叠默认关（回合
               工作过程始终平铺，不出现折叠行）；工具调用汇总默认开（现状，
               结束后折回摘要行）。 -->
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.messageFolding') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.turnFolding') }}
                <span class="hint">{{ t('settings.turnFoldingHint') }}</span>
              </span>
              <Switch
                :model-value="turnFolding"
                :label="t('settings.turnFolding')"
                @update:model-value="setTurnFolding"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.activityRunFolding') }}
                <span class="hint">{{ t('settings.activityRunFoldingHint') }}</span>
              </span>
              <Switch
                :model-value="activityRunFolding"
                :label="t('settings.activityRunFolding')"
                @update:model-value="setActivityRunFolding"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.sessionTitleSection') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.autoSessionTitle') }}
                <span class="hint">{{ t('settings.autoSessionTitleHint') }}</span>
              </span>
              <Switch
                :model-value="config?.autoSessionTitle !== false"
                :label="t('settings.autoSessionTitle')"
                @update:model-value="toggleAutoSessionTitle"
              />
            </div>
            </div>
          </section>
        </section>

        <section v-show="activeTab === 'advanced'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.versionAndUpdates') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.appVersion') }}
                <span class="hint">{{ t('settings.appVersionHint') }}</span>
              </span>
              <button class="rvalue app-version-trigger" type="button" @click="onAppVersionClick">{{ appVersionText }}</button>
            </div>
            <div v-if="desktopBridge" class="row">
              <span class="rlabel">
                {{ t('settings.coreRef') }}
                <span class="hint">{{ t('settings.coreRefHint') }}</span>
              </span>
              <span class="rvalue">{{ coreRefText }}</span>
            </div>
            <div v-if="!desktopBridge" class="row">
              <span class="rlabel">
                {{ t('settings.serverVersion') }}
                <span class="hint">{{ t('settings.serverVersionHint') }}</span>
              </span>
              <span class="rvalue-wrap">
                <span class="rvalue">{{ serverVersion || '-' }}</span>
                <IconButton
                  v-if="serverVersion"
                  size="sm"
                  :label="copiedServerVersion ? t('settings.copied') : t('settings.copyServerVersion')"
                  :tooltip="copiedServerVersion ? t('settings.copied') : t('settings.copyServerVersion')"
                  @click="copyServerVersion"
                >
                  <Icon v-if="!copiedServerVersion" name="copy" size="md" />
                  <Icon v-else class="sd-check" name="check" size="md" />
                </IconButton>
              </span>
            </div>
            <div v-if="!desktopBridge" class="row">
              <span class="rlabel">
                {{ t('settings.serverAddress') }}
                <span class="hint">{{ t('settings.serverAddressHint') }}</span>
              </span>
              <span class="rvalue-wrap">
                <span class="rvalue">{{ daemonEndpoint }}</span>
                <IconButton
                  size="sm"
                  :label="copiedServerAddress ? t('settings.copied') : t('settings.copyServerAddress')"
                  :tooltip="copiedServerAddress ? t('settings.copied') : t('settings.copyServerAddress')"
                  @click="copyServerAddress"
                >
                  <Icon v-if="!copiedServerAddress" name="copy" size="md" />
                  <Icon v-else class="sd-check" name="check" size="md" />
                </IconButton>
              </span>
            </div>
            <div v-if="updateTracker.canCheck" class="row">
              <span class="rlabel">
                {{ t('settings.checkUpdate') }}
                <span v-if="checkResultText" class="hint">{{ checkResultText }}</span>
                <span v-else class="hint">{{ t('settings.checkUpdateHint') }}</span>
              </span>
              <Button variant="secondary" size="sm" :disabled="checkingUpdate" @click="onCheckUpdate">
                {{ checkingUpdate ? t('settings.updateChecking') : t('settings.checkUpdateBtn') }}
              </Button>
            </div>
            <div v-if="updateTracker.canToggleAutoDownload" class="row">
              <span class="rlabel">
                {{ t('settings.autoDownloadUpdate') }}
                <span class="hint">{{ t('settings.autoDownloadUpdateHint') }}</span>
              </span>
              <Switch
                :model-value="updateTracker.autoDownload.value"
                :label="t('settings.autoDownloadUpdate')"
                @update:model-value="onAutoDownloadChange"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.diagnostics') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.debugMode') }}
                <span class="hint">{{ t('settings.debugModeHint') }}</span>
              </span>
              <Switch
                :model-value="isTraceEnabled()"
                :label="t('settings.debugMode')"
                @update:model-value="setTraceEnabled"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.exportLog') }}
                <span class="hint">{{ t('settings.exportLogHint') }}</span>
              </span>
              <Button variant="secondary" size="sm" @click="exportLog">{{ t('settings.exportLogBtn') }}</Button>
            </div>
            </div>
          </section>

          <section v-if="desktopBridge" class="sec">
            <h3 class="sec-title">{{ t('settings.accessibility') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.terminalScreenReader') }}
                <span class="hint">{{ t('settings.terminalScreenReaderHint') }}</span>
              </span>
              <Switch
                :model-value="terminalScreenReader"
                :label="t('settings.terminalScreenReader')"
                @update:model-value="setTerminalScreenReader"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.agreements') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">{{ t('settings.userAgreement') }}</span>
              <IconButton
                size="sm"
                :label="t('settings.userAgreement')"
                :tooltip="t('settings.userAgreement')"
                @click="openAgreement(USER_AGREEMENT_URL)"
              >
                <Icon name="external-link" size="md" />
              </IconButton>
            </div>
            <div class="row">
              <span class="rlabel">{{ t('settings.privacyPolicy') }}</span>
              <IconButton
                size="sm"
                :label="t('settings.privacyPolicy')"
                :tooltip="t('settings.privacyPolicy')"
                @click="openAgreement(PRIVACY_POLICY_URL)"
              >
                <Icon name="external-link" size="md" />
              </IconButton>
            </div>
            </div>
          </section>
        </section>

        <section v-show="activeTab === 'lab'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.lab.betaGroup') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.lab.enableAllBeta') }}
                <span class="hint">{{ t('settings.lab.enableAllBetaHint') }}</span>
                <span v-if="betaMasterLockedByEnv && betaMasterState" class="hint">
                  {{ t('settings.lab.lockedByEnv', { env: betaMasterState.env }) }}
                </span>
              </span>
              <Switch
                :model-value="betaMasterEnabled"
                :disabled="betaMasterLockedByEnv"
                :label="t('settings.lab.enableAllBeta')"
                @update:model-value="onBetaMasterChange"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.lab.contextInspector') }}
                <span class="hint">{{ t('settings.lab.contextInspectorHint') }}</span>
                <span v-if="betaMasterEnabled" class="hint">
                  {{ t('settings.lab.lockedByBetaMaster') }}
                </span>
              </span>
              <Switch
                :model-value="contextInspectorEnabled"
                :disabled="betaMasterEnabled"
                :label="t('settings.lab.contextInspector')"
                @update:model-value="onContextInspectorChange"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.lab.notifyUser') }}
                <span class="hint">{{ t('settings.lab.notifyUserHint') }}</span>
                <span v-if="notifyUserLockedByEnv && notifyUserFeature" class="hint">
                  {{ t('settings.lab.lockedByEnv', { env: notifyUserFeature.env }) }}
                </span>
                <span v-else-if="betaMasterEnabled" class="hint">
                  {{ t('settings.lab.lockedByBetaMaster') }}
                </span>
              </span>
              <Switch
                :model-value="notifyUserEnabled"
                :disabled="notifyUserLocked"
                :label="t('settings.lab.notifyUser')"
                @update:model-value="onNotifyUserChange"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.lab.experimentalGroup') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.lab.sessionMentions') }}
                <span class="hint">{{ t('settings.lab.sessionMentionsHint') }}</span>
              </span>
              <Switch
                :model-value="sessionMentions"
                :label="t('settings.lab.sessionMentions')"
                @update:model-value="onSessionMentionsChange"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.lab.tower') }}
                <span class="hint">{{ t('settings.lab.towerHint') }}</span>
                <span v-if="towerLockedByEnv && towerFeature" class="hint">
                  {{ t('settings.lab.lockedByEnv', { env: towerFeature.env }) }}
                </span>
                <span v-else-if="towerPendingRestart" class="hint">
                  {{ t('settings.lab.towerPendingRestart') }}
                </span>
              </span>
              <Switch
                :model-value="towerToggleEnabled"
                :disabled="towerLockedByEnv"
                :label="t('settings.lab.tower')"
                @update:model-value="onTowerChange"
              />
            </div>
            </div>
          </section>
        </section>

        <!-- Archived sessions -->
        <section v-show="activeTab === 'archived'" class="panel">
          <div class="panel-head">
            <h4 class="panel-title">{{ t('settings.archivedTitle') }}</h4>
            <p class="panel-desc">{{ t('settings.archivedDesc') }}</p>
          </div>

          <div class="archive-toolbar">
            <label class="archive-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input v-model="archiveQuery" :placeholder="t('settings.archivedSearch')" />
            </label>
            <Select
              :model-value="archiveWsFilter"
              :options="archiveWorkspaceSelectOptions"
              size="sm"
              :aria-label="t('settings.archivedAllWorkspaces')"
              @update:model-value="archiveWsFilter = $event as string"
            />
            <SegmentedControl
              size="sm"
              :model-value="archiveSort"
              :options="[
                { value: 'archived-desc', label: t('settings.archivedSortArchived'), icon: 'clock' },
                { value: 'created-desc', label: t('settings.archivedSortCreated'), icon: 'calendar-schedule' },
                { value: 'name-asc', label: t('settings.archivedSortName'), icon: 'sort' },
              ]"
              @update:model-value="archiveSort = $event as 'archived-desc' | 'created-desc' | 'name-asc'"
            />
          </div>

          <div v-if="archivedLoading" class="archive-empty">
            {{ t('settings.archivedLoadingAll') }}
          </div>

          <template v-else>
            <div v-if="groupedArchived.length > 0" class="archive-list">
              <section v-for="g in groupedArchived" :key="g.cwd" class="archive-card">
                <div class="archive-workspace">
                  <Icon name="folder-closed" size="md" />
                  <span class="path">{{ g.cwd }}</span>
                  <span class="count">{{ t('settings.archivedSessionsCount', { count: g.items.length }) }}</span>
                </div>
                <div class="setting-card">
                  <div v-for="s in g.items" :key="s.id" class="archive-row">
                    <div class="archive-meta">
                      <div class="archive-name">{{ s.title }}</div>
                      <div class="archive-time">{{ t('settings.archivedAt', { time: archiveTime(s.archivedAt ?? s.updatedAt) }) }}</div>
                    </div>
                    <Button variant="secondary" size="sm" @click="onRestore(s.id)">
                      <Icon name="undo" size="sm" />
                      <span>{{ t('settings.archivedRestore') }}</span>
                    </Button>
                    <Button variant="danger" size="sm" @click="onDeleteArchived(s)">
                      <Icon name="trash" size="sm" />
                      <span>{{ t('admin.delete') }}</span>
                    </Button>
                  </div>
                </div>
              </section>
            </div>
            <div v-else class="archive-empty">
              {{ archivedItems.length === 0 ? t('settings.archivedEmpty') : t('settings.archivedNoMatch') }}
            </div>
          </template>
        </section>

        <!-- Providers (accordion management). v-if (not v-show): the panel
             refetches providers/models on mount, so reopening the tab always
             shows fresh data. -->
        <section v-if="activeTab === 'providers'" class="panel">
          <ProvidersPanel @login="emit('login')" />
        </section>

        <section v-if="activeTab === 'plugins'" class="panel">
          <PluginsPanel />
        </section>

        <!-- Hotkeys (desktop-only). v-if (not v-show): the panel
             owns a document-level recording listener, so it must unmount
             when the tab is hidden — a hidden-but-mounted recorder would
             keep swallowing keys typed in the now-visible tab. -->
        <section v-if="activeTab === 'shortcuts'" class="panel">
          <ShortcutsPanel :initial-action="props.initialShortcutAction" />
        </section>

        </div>
      </section>
    </div>
    <RuntimeEnvironmentDialog
      v-if="runtimeEnvironmentOpen"
      :overrides="runtimeEnvironmentOverrides"
      @close="runtimeEnvironmentOpen = false"
    />
  </Dialog>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.sd {
  display: grid;
  grid-template-columns: 184px 1fr;
  grid-template-areas: "tabs region";
  min-height: 0;
  height: 100%;
  user-select: none;
}
.sd :is(input, textarea, [contenteditable='true']) {
  user-select: text;
}
.settings-region { display: flex; min-width: 0; min-height: 0; flex-direction: column; grid-area: region; }
.settings-region-header,
.settings-tabs-header {
  display: flex;
  align-items: center;
  height: calc(var(--space-4) + var(--icon-button-sm) + var(--space-2));
  box-sizing: border-box;
}
.settings-region-header { justify-content: flex-end; padding-right: var(--space-5); }
.settings-tabs-header { padding-inline: var(--space-3); }
.settings-dialog-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  color: var(--color-text);
}

.settings-tabs {
  display: flex;
  flex-direction: column;
  width: 184px;
  padding: 0 var(--space-2) var(--space-2);
  gap: 2px;
  overflow-y: auto;
  border-right: var(--p-hairline) solid var(--color-line);
  grid-area: tabs;
}
.settings-tab-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-ui-strong);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.tab:hover { background: var(--color-hover); color: var(--color-text-strong); }
.tab.on { background: var(--color-hover); color: var(--color-text); }
.tab:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.body { display: flex; flex-direction: column; overflow-y: auto; scrollbar-gutter: stable; padding: var(--space-2) 32px var(--space-5); flex: 1; min-width: 0; }
.body::-webkit-scrollbar { width: 4px; }
.body::-webkit-scrollbar-track { background: transparent; }
.body::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: var(--radius-full);
  transition: background var(--duration-base) var(--ease-out);
}
.body.scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.body.scrolling::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}
.panel { display: block; }
.sec { padding: var(--space-4) 0; }
.panel > .sec:first-child,
.panel-sections > .sec:first-child { padding-top: 0; }
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.notification-settings { user-select: none; }
.sec-head .sec-title { margin-bottom: 0; }




.settings-group > .empty-config { padding: var(--space-3); }
.account-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
}
.account-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}
.account-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.account-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.account-level {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.account-meta {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.account-name {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-sub {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.rvalue.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.app-version-trigger {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: right;
  cursor: default;
}
.app-version-trigger:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}


.sd-check { color: var(--color-success); }
.hint { font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--color-text-faint); }

.body :deep(.ui-seg),
.body :deep(.ui-select__trigger),
.body :deep(.ui-button),
.archive-search {
  border-width: var(--p-hairline);
}



.empty-config {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  padding: var(--space-1) 0;
}

@media (max-width: 640px) {
  .sd {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    grid-template-areas:
      "tabs"
      "region";
  }
  .settings-tabs {
    width: auto;
    padding: 0;
    overflow-x: visible;
    border-right: none;
    border-bottom: var(--p-hairline) solid var(--color-line);
  }
  .settings-tabs-header {
    padding: var(--space-3);
  }
  .settings-tab-list {
    flex-direction: row;
    gap: var(--space-1);
    overflow-x: auto;
    padding: 0 var(--space-3) var(--space-2);
  }
  .settings-region-header { padding: var(--space-3); }
  .body { padding-inline: var(--space-3); }
  .tab { white-space: nowrap; flex: none; }
  .row {
    align-items: flex-start;
    flex-direction: column;
  }
  .settings-group { margin-inline: 0; }
  .select-wrap {
    width: 100%;
    max-width: none;
  }
}
.setting-card { border-radius: var(--radius-xl); overflow: hidden; background: var(--color-surface); }
.panel-head { margin-bottom: var(--space-4); }
.panel-title { margin: 0 0 var(--space-2); font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); letter-spacing: 0; color: var(--color-text); }
.panel-desc { margin: 0; font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--color-text-muted); max-width: 560px; }
.archive-toolbar { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; }
.archive-search { flex: 1; min-width: 200px; height: 36px; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border-radius: var(--radius-md); border: var(--p-hairline) solid var(--color-line); color: var(--color-text-faint); font-size: var(--text-xs); background: var(--color-surface-overlay); transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.archive-search:focus-within { border-color: var(--color-accent); box-shadow: var(--p-focus-ring); color: var(--color-text-muted); }
.archive-search svg { width: 15px; height: 15px; flex: none; }
.archive-search input { width: 100%; border: none; outline: none; background: transparent; font: inherit; color: var(--color-text); }
.archive-list { display: flex; flex-direction: column; gap: var(--space-4); }
.archive-card .setting-card { margin-bottom: 0; }
.archive-workspace { display: flex; align-items: center; gap: var(--space-2); margin: 0 2px var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.archive-workspace svg { width: 16px; height: 16px; color: var(--color-text-faint); flex: none; }
.archive-workspace .path { font-family: var(--font-ui); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-workspace .count { margin-left: auto; color: var(--color-text-faint); font-weight: var(--weight-medium); font-size: var(--text-xs); flex: none; }
.archive-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-top: var(--p-hairline) solid var(--color-line); }
.archive-row:first-child { border-top: none; }
.archive-row:hover { background: var(--color-hover); }
.archive-meta { min-width: 0; }
.archive-name { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-time { margin-top: 2px; font-size: var(--text-xs); color: var(--color-text-faint); font-family: var(--font-ui); }
.archive-draining { margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent-hover); font-size: var(--text-xs); }
.archive-empty { padding: var(--space-6) var(--space-4); border-radius: var(--radius-xl); color: var(--color-text-faint); font-size: var(--text-xs); text-align: center; background: var(--color-surface); }
@media (max-width: 640px) {
  .archive-toolbar { flex-direction: column; align-items: stretch; }
  .archive-search { min-width: 0; }
}
:deep(.ui-dialog--fixed-height) { height: min(780px, calc(var(--app-height, 100vh) - var(--space-8) * 2)); }
</style>

<style>
.ui-dialog.settings-dialog {
  width: min(980px, 96vw);
  max-width: min(880px, 96vw);
}
.ui-dialog.ui-dialog--fixed-height.settings-dialog {
  transition: height var(--duration-slow) var(--ease-in-out);
}
@media (prefers-reduced-motion: reduce) {
  .ui-dialog.ui-dialog--fixed-height.settings-dialog { transition: none; }
}
</style>
