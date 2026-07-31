<!-- apps/web/src/components/settings/SettingsDialog.vue -->
<!-- The app's dedicated Settings page (modal). Consolidates what used to be
     scattered in the sidebar account popover: appearance, language, account,
     connection, plus notifications and the troubleshooting-log export. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import type { AppSession } from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import LanguageSwitcher from './LanguageSwitcher.vue';
import ShortcutsPanel from './ShortcutsPanel.vue';
import ProvidersPanel from './ProvidersPanel.vue';
import { canOpenInNative, listNativeOpenInApps, openInAppIcon, saveDefaultOpenInTarget, useDefaultOpenInTarget } from '../../lib/nativeOpenIn';
import { canSetDockIconChoice, useDockIconChoice, type DockIconChoice } from '../../lib/dockIconChoice';
import { logWarn } from '../../lib/log';
import { track } from '../../lib/track';
import DockIconPicker from './DockIconPicker.vue';
import { isMacosDesktop } from '../../lib/desktopFlag';
import { useVibrancy } from '../../composables/useVibrancy';
import { serverEndpointLabel } from '../../api/config';
import { downloadTraceLog, isTraceEnabled } from '../../debug/trace';
import { useUpdateStatus, type UpdateCheckResult } from '../../composables/useUpdateStatus';
import type { ColorScheme, FontScale } from '../../composables/useKimiWebClient';
import type { AppConfig, AppModel, ManagedUserInfo, ManagedUsageResult } from '../../api/types';
import PlanUsageCard from './PlanUsageCard.vue';
import PlanUpgradeCard from './PlanUpgradeCard.vue';
import type { IconName } from '../../lib/icons';
import { Badge, Button, Dialog, Icon, IconButton, SegmentedControl, Select, Switch } from '@moonshot-ai/web-ui';

const { t } = useI18n();

// Frosted-sidebar switch (macOS desktop only — the row below is v-if'd on
// isMacosDesktop; web never renders it).
const { vibrancy, setVibrancy } = useVibrancy();

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

function onNotifyChange(on: boolean): void {
  emit('setNotify', on);
  track('settings_changed', { key: 'notifications', value: on ? 'on' : 'off', source_panel: 'settings' });
}

type SettingsTab = 'general' | 'agent' | 'account' | 'providers' | 'advanced' | 'archived' | 'shortcuts';

const props = defineProps<{
  colorScheme: ColorScheme;
  fontScale: FontScale;
  /** Managed Kimi account credential state from GET /api/v1/auth
      ('authenticated' | 'unauthenticated' | null when unconfigured). The
      account row keys off THIS, not a global "any usable model exists" flag —
      third-party providers keep readiness true after a Kimi logout. */
  managedProviderStatus?: string | null;
  /** Signed-in managed-account profile (GET /oauth/userinfo); drives the
      avatar and nickname on the account row, which keeps its anonymous
      fallback while the profile is absent or still loading. */
  managedUserInfo?: ManagedUserInfo | null;
  /** Fetches managed-account plan usage for the Plan Usage section (account
      tab, signed-in only); failures surface inline in the card. */
  onFetchUsage: () => Promise<ManagedUsageResult>;
  /** Master system-notification preference (all kinds). */
  notify: boolean;
  /** OS permission state ('default' | 'granted' | 'denied') for the hint. */
  notifyPermission?: string;
  /** Whether notifications play the system sound. */
  notifySound: boolean;
  /** Global daemon config from GET /api/v1/config. Secrets are redacted server-side. */
  config?: AppConfig | null;
  /** Models from the daemon catalog, used to label default-model choices. */
  models?: AppModel[];
  /** True while POST /api/v1/config is saving. */
  configSaving?: boolean;
  /** Server version reported by GET /api/v1/meta. */
  serverVersion?: string;
  /** Tab to open on (default 'general'); deep links like the onboarding
      custom-provider entry land on 'providers'. Read once at mount. */
  initialTab?: SettingsTab;
}>();

const emit = defineEmits<{
  setColorScheme: [colorScheme: ColorScheme];
  setFontScale: [scale: FontScale];
  setNotify: [on: boolean];
  setNotifySound: [on: boolean];
  login: [];
  logout: [];
  updateConfig: [patch: Partial<AppConfig>];
  close: [];
}>();

const signedIn = computed(() => props.managedProviderStatus === 'authenticated');

const accountName = computed(() => {
  if (!signedIn.value) return t('sidebar.notSignedIn');
  return props.managedUserInfo?.nickname || t('sidebar.defaultUserName');
});

// Server-supplied level label (may be ''), shown as a badge next to the name.
const accountLevel = computed(() => props.managedUserInfo?.userLevelName?.trim() ?? '');

// A broken avatar URL falls back to the placeholder glyph; a new profile
// (re-login) re-arms the <img>.
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

const activeTab = ref<SettingsTab>(props.initialTab ?? 'general');

// Overlay-style scrollbar, same as the sidebar's .sessions: the thin thumb
// stays hidden until the body is scrolled, then fades back out shortly after
// the last scroll event (see the .body::-webkit-scrollbar-thumb rules).
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

const tabs: { id: SettingsTab; labelKey: string; icon: IconName }[] = [
  { id: 'general', labelKey: 'settings.tabs.general', icon: 'sliders' },
  { id: 'agent', labelKey: 'settings.tabs.agent', icon: 'robot' },
  { id: 'account', labelKey: 'settings.tabs.account', icon: 'user' },
  // No plug-style glyph exists in the icon registry; the bolt is the closest.
  { id: 'providers', labelKey: 'settings.tabs.providers', icon: 'bolt' },
  // Desktop-only tab (web's copy stops at 'archived'; docs/native-todos.md).
  { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', icon: 'keyboard' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced', icon: 'microscope' },
  { id: 'archived', labelKey: 'settings.tabs.archived', icon: 'archive' },
];

const daemonEndpoint = serverEndpointLabel();
// Escalating autonomy order, matching the Composer's permission menu and the
// protocol's PermissionMode enum: manual < yolo (auto-approves tools) < auto
// (fully autonomous, never asks).
const permissionModes = ['manual', 'yolo', 'auto'] as const;
// Reuse the Composer's permission labels (status.permission*) so the
// default-permission names stay in sync with the toolbar.
const permissionLabelKey: Record<(typeof permissionModes)[number], string> = {
  manual: 'status.permissionManual',
  auto: 'status.permissionAuto',
  yolo: 'status.permissionYolo',
};

// Modal focus: move focus into the dialog on open, restore it to the opener on
// close (Escape-to-close is handled below).
const dialogRef = ref<HTMLElement | null>(null);
useDialogFocus(dialogRef);

// A stacked global confirm (e.g. sign-out) owns Escape while it's open.
const { isConfirmOpen } = useConfirmDialog();

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !isConfirmOpen.value) emit('close');
}
onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  if (bodyScrollHideTimer) clearTimeout(bodyScrollHideTimer);
});

// Desktop-only: default "open workspace in <app>" target. The catalog comes
// from the main process via lib/nativeOpenIn.ts; the row stays hidden without
// the bridge (web) or with an empty catalog (non-macOS). The value is the
// shared reactive selection (null = unset → first available shown), so the
// header pill updates live — a menu pick writes the same key.
const openInAppOptions = ref<Array<{ value: string; label: string; icon?: string }> | null>(null);
const defaultOpenInApp = useDefaultOpenInTarget();

function onDefaultOpenInChange(appId: string): void {
  saveDefaultOpenInTarget(appId);
  // The catalog ids are main-process enums; '' means "cleared back to auto".
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

// Desktop-only (macOS): Dock icon tile preference (lib/dockIconChoice.ts —
// the choice pushes to the main process over the preload bridge). Web's copy
// has no such row (docs/native-todos.md).
const dockIconChoice = useDockIconChoice();
const showDockIconRow = isMacosDesktop && canSetDockIconChoice();

// The Dock-icon choice is tracked HERE (not in lib/dockIconChoice.ts): the
// settings row is the only UI that changes it, so one site covers every edit.
function onDockIconChange(value: DockIconChoice): void {
  dockIconChoice.value = value;
  track('settings_changed', { key: 'dock-icon', value, source_panel: 'settings' });
}

function exportLog(): void {
  downloadTraceLog();
}

// ---------------------------------------------------------------------------
// Advanced tab — app version + build time (compile-time defines injected by
// both apps' Vite configs / the shared preset), and the desktop-only manual
// update check. The check row hides without a capable bridge (plain web), so
// this whole section stays identical across the desktop/web copies.
// ---------------------------------------------------------------------------
const appVersionText = (() => {
  const version =
    typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
      ? __KIMI_CLIENT_VERSION__
      : '';
  let built = '';
  if (typeof __KIMI_BUILD_TIME__ === 'string' && __KIMI_BUILD_TIME__.trim()) {
    const d = new Date(__KIMI_BUILD_TIME__);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number): string => String(n).padStart(2, '0');
      built = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  const text = built === '' ? version : `${version} · ${built}`;
  return text === '' ? '-' : text;
})();

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
      // The feedback mirrors what auto-download is doing with the find: a
      // landed download points at the restart, an auto-mode find is already
      // downloading, and only manual mode still needs the sidebar entry.
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
    group.options.map((model) => ({ value: model.id, label: model.label, group: group.provider })),
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
  if (model && resolvedProvider) return `${id} (${resolvedProvider}/${model})`;
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

function toggleConfigBoolean(key: 'defaultPlanMode'): void {
  const current = props.config?.[key];
  emit('updateConfig', { [key]: !configBool(current) } as Partial<AppConfig>);
}

// "Default thinking" lives at config.thinking.enabled on the daemon — the legacy
// top-level defaultThinking field was removed. Read/write it there so the toggle
// actually persists (the old field was silently stripped by the server).
//
// Mirror the core resolver: thinking is on unless explicitly disabled
// (enabled === false). An absent thinking section — or one with an effort but no
// enabled field — falls through to the model/default effort (on for
// thinking-capable models), so the toggle reflects that as on.
function thinkingEnabled(): boolean {
  const thinking = props.config?.thinking;
  if (!thinking || typeof thinking !== 'object') return true;
  return (thinking as { enabled?: boolean }).enabled !== false;
}

function toggleDefaultThinking(): void {
  emit('updateConfig', { thinking: { enabled: !thinkingEnabled() } } as Partial<AppConfig>);
}

// Telemetry is opt-out: undefined and `true` both mean enabled, only explicit
// `false` disables it. Toggle based on that effective state so an unset value
// (displayed as on) flips to `false` instead of writing a redundant `true`.
function toggleTelemetry(): void {
  const enabled = props.config?.telemetry !== false;
  track('telemetry_consent_changed', { enabled: !enabled });
  emit('updateConfig', { telemetry: !enabled } as Partial<AppConfig>);
}

function setTab(tab: SettingsTab): void {
  activeTab.value = tab;
}

// ---------------------------------------------------------------------------
// Archived-sessions tab — its own list state (server-side `archived_only`
// filter), kept separate from the per-workspace active list. Search, workspace
// filter and sort all run client-side over the loaded pages. Restore goes
// through the composable so the sidebar list updates automatically.
// ---------------------------------------------------------------------------
const client = useKimiWebClient();

// A confirmed free managed account (the userinfo probe was rejected with 402)
// gets the upgrade entry instead of the plan-usage module — free accounts
// can't call usages, so there is nothing to meter. While the probe is still
// unknown the usage card mounts as usual and swaps itself on a 402/403.
const showPlanUpgrade = computed(() => signedIn.value && client.managedMembership.value === 'free');

const archivedItems = ref<AppSession[]>([]);
const archivedLoading = ref(false);
const archivedLoaded = ref(false);
const archiveQuery = ref('');
const archiveWsFilter = ref<string>('all'); // 'all' | cwd
const archiveSort = ref<'archived-desc' | 'created-desc' | 'name-asc'>('archived-desc');

// Load every archived session once when the tab opens (no frontend pagination).
// Search, sort and the workspace filter then run client-side over the full set,
// so results are always global and there is no empty-page / cursor bookkeeping
// to get wrong. The user waits a moment on first open in exchange for simplicity.
const ARCHIVED_PAGE_SIZE = 100;

async function loadAllArchived(): Promise<void> {
  if (archivedLoading.value || archivedLoaded.value) return;
  archivedLoading.value = true;
  try {
    const all: AppSession[] = [];
    let beforeId: string | undefined;
    for (;;) {
      const page = await client.loadArchivedSessions({ beforeId, pageSize: ARCHIVED_PAGE_SIZE });
      all.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      const next = page.items.at(-1)?.id;
      if (next === undefined) break;
      beforeId = next;
    }
    archivedItems.value = all;
    archivedLoaded.value = true;
  } catch (err) {
    logWarn('loadAllArchived failed', err);
  } finally {
    archivedLoading.value = false;
  }
}

// immediate: the dialog may MOUNT on the archived tab (initialTab deep link,
// e.g. the archive undo toast) — no tab change fires then.
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
  // Defensive invariant: this panel must only ever render archived sessions,
  // even if an older server ignores `archived_only` and falls back to the
  // default (unarchived) list. Filter again on the client.
  let rows = archivedItems.value.filter((s) => s.archived === true);
  if (archiveWsFilter.value !== 'all') {
    rows = rows.filter((s) => s.cwd === archiveWsFilter.value);
  }
  if (q) rows = rows.filter((s) => s.title.toLowerCase().includes(q));
  rows = rows.slice();
  if (archiveSort.value === 'archived-desc') {
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

function archiveTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <Dialog :open="true" :close-on-esc="false" :aria-label="t('settings.title')" size="xl" height="fixed" :padded="false" level="grouped" @close="emit('close')">
    <div ref="dialogRef" class="sd">
      <nav class="settings-tabs" role="tablist" :aria-label="t('settings.title')">
        <header class="settings-tabs-header">
          <h2 class="settings-dialog-title">{{ t('settings.title') }}</h2>
        </header>
        <div class="settings-tab-list">
          <button
            v-for="tb in tabs"
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
          <IconButton size="sm" :label="t('settings.close')" @click="emit('close')">
            <Icon name="close" size="md" />
          </IconButton>
        </header>
        <div class="body" :class="{ scrolling: bodyScrolling }" @scroll="onBodyScroll">
        <!-- General: Appearance + Notifications -->
        <section v-show="activeTab === 'general'" class="panel">
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
            <div v-if="showDockIconRow" class="row">
              <span class="rlabel">
                {{ t('settings.appIcon') }}
                <span class="hint">{{ t('settings.appIconHint') }}</span>
              </span>
              <DockIconPicker :model-value="dockIconChoice" @update:model-value="onDockIconChange" />
            </div>
            <div class="row font-size-row">
              <span class="rlabel">
                {{ t('settings.uiFontSize') }}
                <span class="hint">{{ t('settings.uiFontSizeHint') }}</span>
              </span>
              <SegmentedControl
                :model-value="fontScale"
                :options="[
                  { value: 'small', label: 'S' },
                  { value: 'medium', label: 'M' },
                  { value: 'large', label: 'L' },
                  { value: 'xlarge', label: 'XL' },
                ]"
                :aria-label="t('settings.uiFontSize')"
                @update:model-value="onFontScale($event as FontScale)"
              />
            </div>
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
            <div class="row language-row">
              <span class="rlabel">
                {{ t('sidebar.language') }}
                <span class="hint">{{ t('settings.languageHint') }}</span>
              </span>
              <LanguageSwitcher />
            </div>
            <div v-if="openInAppOptions" class="row">
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
        </section>

        <!-- Account -->
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
              <Button v-if="signedIn" variant="danger-soft" size="sm" @click="emit('logout')">{{ t('sidebar.signOut') }}</Button>
              <Button v-else variant="primary" size="sm" @click="emit('login')">{{ t('sidebar.signIn') }}</Button>
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

        <!-- Agent defaults -->
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
                <Switch
                  :model-value="thinkingEnabled()"
                  :label="t('settings.defaultThinking')"
                  @update:model-value="toggleDefaultThinking()"
                />
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
        </section>

        <!-- Advanced: version & updates + data/privacy + diagnostics -->
        <section v-show="activeTab === 'advanced'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.versionAndUpdates') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.appVersion') }}
                <span class="hint">{{ t('settings.appVersionHint') }}</span>
              </span>
              <span class="rvalue">{{ appVersionText }}</span>
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.serverVersion') }}
                <span class="hint">{{ t('settings.serverVersionHint') }}</span>
              </span>
              <span class="rvalue">{{ serverVersion || '-' }}</span>
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.serverAddress') }}
                <span class="hint">{{ t('settings.serverAddressHint') }}</span>
              </span>
              <span class="rvalue">{{ daemonEndpoint }}</span>
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

          <section v-if="config" class="sec">
            <h3 class="sec-title">{{ t('settings.privacy') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.telemetry') }}
                <span class="hint">{{ t('settings.telemetryHint') }}</span>
                <span class="hint">{{ t('settings.telemetryRestartHint') }}</span>
              </span>
              <Switch
                :model-value="config.telemetry !== false"
                :disabled="configSaving"
                :label="t('settings.telemetry')"
                @update:model-value="toggleTelemetry()"
              />
            </div>
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.diagnostics') }}</h3>
            <div class="settings-group">
            <div class="row">
              <span class="rlabel">
                {{ t('settings.exportLog') }}
                <span class="hint">{{ t('settings.exportLogHint') }}</span>
                <span v-if="!isTraceEnabled()" class="hint">{{ t('settings.logHint') }}</span>
              </span>
              <Button variant="secondary" size="sm" @click="exportLog">{{ t('settings.exportLogBtn') }}</Button>
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
                      <div class="archive-time">{{ t('settings.archivedAt', { time: archiveTime(s.updatedAt) }) }}</div>
                    </div>
                    <Button variant="secondary" size="sm" @click="onRestore(s.id)">
                      <Icon name="undo" size="sm" />
                      <span>{{ t('settings.archivedRestore') }}</span>
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
          <ProvidersPanel />
        </section>

        <!-- Hotkeys (desktop-only). v-if (not v-show): the panel
             owns a document-level recording listener, so it must unmount
             when the tab is hidden — a hidden-but-mounted recorder would
             keep swallowing keys typed in the now-visible tab. -->
        <section v-if="activeTab === 'shortcuts'" class="panel">
          <ShortcutsPanel />
        </section>

        </div>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.sd {
  display: grid;
  grid-template-columns: 148px 1fr;
  grid-template-areas: "tabs region";
  min-height: 0;
  height: 100%;
  user-select: none;
}
.sd :is(input, textarea, [contenteditable='true']) {
  user-select: text;
}
/* The dialog panel is the grouped canvas (Dialog level="grouped" →
   --color-bg); the region and tab rail stay transparent on top of it so
   only the cards rise one rung lighter (--color-surface). */
.settings-region { display: flex; min-width: 0; min-height: 0; flex-direction: column; grid-area: region; }
/* Sidebar title row and the region's close-button row share one fixed height so
   the first tab and the first section title land on the same line. */
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
  width: 148px;
  padding: 0 var(--space-2) var(--space-2);
  gap: 2px;
  overflow-y: auto;
  border-right: 0.5px solid var(--color-line);
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
/* Selected = the same neutral f1 wash as hover, text just brightens —
   synced with the Kimi app settings nav (.ss-nav-item:hover and
   .ss-nav-item--active share one rule: background Fills-F1, colour stays
   Labels-Primary). Never accent-tinted: it means "where I am". */
.tab.on { background: var(--color-hover); color: var(--color-text); }
.tab:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.body { display: flex; flex-direction: column; overflow-y: auto; padding: var(--space-2) 32px var(--space-5); flex: 1; min-width: 0; }
/* Scrollbar identical to the sidebar's .sessions: 4px, hidden at rest. */
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
/* The first section's top spacing comes from .body so its title lines up with
   the first sidebar tab. */
.panel > .sec:first-child { padding-top: 0; }
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.sec-title {
  margin: 0 0 var(--space-3);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  letter-spacing: 0;
  color: var(--color-text);
}
.notification-settings { user-select: none; }
.sec-head .sec-title { margin-bottom: 0; }
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 38px;
  padding: var(--space-1) 0;
}
.settings-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.settings-group:has(.ui-select.is-open) {
  position: relative;
  z-index: var(--z-dropdown);
  overflow: visible;
}
.settings-group > .row {
  min-height: 52px;
  padding: var(--space-4);
  border-top: 0.5px solid var(--color-line);
}
.settings-group > .row:first-child { border-top: none; }
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
.rlabel {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--weight-option-label);
  display: flex;
  flex-direction: column;
  gap: 0;
}
.rvalue {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rvalue.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.hint { font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--color-text-faint); }

/* Settings controls use the same fine hairline as the dialog's surrounding
   chrome, including filled controls such as switches. */
.body :deep(.ui-seg),
.body :deep(.ui-select__trigger),
.body :deep(.ui-button),
.archive-search {
  border-width: 0.5px;
}

.select-wrap { min-width: 220px; max-width: min(320px, 50vw); flex: none; }

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
    border-bottom: 0.5px solid var(--color-line);
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
/* Archived-sessions tab */
.setting-card { border-radius: var(--radius-xl); overflow: hidden; background: var(--color-surface); }
.panel-head { margin-bottom: var(--space-4); }
.panel-title { margin: 0 0 var(--space-2); font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); letter-spacing: 0; color: var(--color-text); }
.panel-desc { margin: 0; font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--color-text-muted); max-width: 560px; }
.archive-toolbar { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; }
.archive-search { flex: 1; min-width: 200px; height: 36px; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border-radius: var(--radius-md); border: 0.5px solid var(--color-line); color: var(--color-text-faint); font-size: var(--text-xs); background: var(--color-surface-overlay); transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.archive-search:focus-within { border-color: var(--color-accent); box-shadow: var(--p-focus-ring); color: var(--color-text-muted); }
.archive-search svg { width: 15px; height: 15px; flex: none; }
.archive-search input { width: 100%; border: none; outline: none; background: transparent; font: inherit; color: var(--color-text); }
.archive-list { display: flex; flex-direction: column; gap: var(--space-4); }
.archive-card .setting-card { margin-bottom: 0; }
.archive-workspace { display: flex; align-items: center; gap: var(--space-2); margin: 0 2px var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.archive-workspace svg { width: 16px; height: 16px; color: var(--color-text-faint); flex: none; }
.archive-workspace .path { font-family: var(--font-ui); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-workspace .count { margin-left: auto; color: var(--color-text-faint); font-weight: var(--weight-medium); font-size: var(--text-xs); flex: none; }
.archive-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-top: 0.5px solid var(--color-line); }
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
/* Enlarge the settings frame a bit (Dialog `xl` = 760px wide, fixed-height
   680px). Scoped to this dialog only. */
:deep(.ui-dialog) { width: min(980px, 96vw); }
:deep(.ui-dialog--fixed-height) { height: min(780px, calc(100vh - var(--space-8) * 2)); }
</style>
