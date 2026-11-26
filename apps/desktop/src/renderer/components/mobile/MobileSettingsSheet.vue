<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../../types';
import type { AppModel, ManagedUserInfo, ThinkingLevel } from '../../api/types';
import type { ColorScheme, FontScale } from '@moonshot-ai/app-client/client';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { effortSwitchStore } from '@moonshot-ai/app-client/stores';
import { useActivityRunFolding, useConfirmDialog, usePasteImageAutoMention, useRunningSendMode, useTurnFolding, type RunningSendMode, type SettingsHighlightKey } from '@moonshot-ai/app-client/composables';
import { track } from '../../lib/track';
import {
  commitLevel,
  effectiveThinkingLevel,
  effortLabel,
  hasDesktopBridge,
  isRcLocation,
  modelThinkingAvailability,
  segmentsFor,
} from '@moonshot-ai/app-core/lib';
import { BottomSheet, BrowserTabTitleSetting, FontSettingsPage, FontSettingsRow, ProvidersPanel, useSettingsSubpage } from '@moonshot-ai/app-components';
import type { FontTarget } from '@moonshot-ai/app-core';
import LanguageSwitcher from '../settings/LanguageSwitcher.vue';
import PlanUsageCard from '../settings/PlanUsageCard.vue';
import { formatTokens } from '@moonshot-ai/app-core/lib';
import { Avatar, Badge, Icon, SegmentedControl, Switch } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const { isConfirmOpen } = useConfirmDialog();

const { turnFolding, setTurnFolding } = useTurnFolding();
const { activityRunFolding, setActivityRunFolding } = useActivityRunFolding();
const { pasteImageAutoMention, setPasteImageAutoMention } = usePasteImageAutoMention();
const { runningSendMode, setRunningSendMode } = useRunningSendMode();

function onRunningSendModeChange(mode: RunningSendMode): void {
  setRunningSendMode(mode);
  track('settings_changed', { key: 'running-send-mode', value: mode, source_panel: 'mobile_settings' });
}

const client = useKimiWebClient();
const effortSwitchConfirmPending = computed(() => effortSwitchStore().pending);

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    initialTab?: 'providers';
    highlightKey?: SettingsHighlightKey;
    status: ConversationStatus;
    thinking?: ThinkingLevel;
    planMode?: boolean;
    goalMode?: boolean;
    goalActive?: boolean;
    swarmMode?: boolean;
    /** Tower-mode state for the session (experimental). */
    towerMode?: boolean;
    /** Daemon-reported experimental `tower` flag (GET /meta): the row renders
        only while the flag is on. */
    towerEnabled?: boolean;
    colorScheme?: ColorScheme;
    fontScale?: FontScale;
    managedProviderStatus?: string | null;
    managedUserInfo?: ManagedUserInfo | null;
    serverVersion?: string;
    models?: AppModel[];
  }>(),
  {
    colorScheme: 'system',
    fontScale: 'medium',
    managedProviderStatus: null,
    managedUserInfo: null,
    serverVersion: '',
    models: () => [],
    initialTab: undefined,
    highlightKey: undefined,
  },
);

const view = ref<'main' | 'providers'>('main');
const fontPage = useSettingsSubpage<FontTarget>();
const fontPageTarget = fontPage.page;
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

watch(
  [() => props.modelValue, () => props.initialTab],
  ([open]) => {
    view.value = open && props.initialTab === 'providers' ? 'providers' : 'main';
    fontPage.reset();
  },
  { immediate: true },
);

watch(
  [() => props.modelValue, () => props.highlightKey],
  ([open, key]) => {
    clearHighlightTimer();
    if (!open || !key || props.initialTab === 'providers') {
      highlightedSetting.value = null;
      return;
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
  },
  { immediate: true },
);

watch([view, fontPageTarget], () => {
  if (view.value !== 'main' || fontPageTarget.value !== null) {
    clearHighlightTimer();
    highlightedSetting.value = null;
  }
});

onUnmounted(() => {
  clearHighlightTimer();
});

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  pickModel: [];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleGoal: [];
  focusGoal: [];
  toggleSwarm: [];
  toggleTower: [];
  setPermission: [mode: PermissionMode];
  setColorScheme: [colorScheme: ColorScheme];
  setFontScale: [scale: FontScale];
  login: [];
  logout: [];
}>();

function onColorScheme(v: string): void {
  emit('setColorScheme', v as ColorScheme);
}

const PERM_MODES: PermissionMode[] = ['manual', 'yolo', 'auto'];

const currentModel = computed<AppModel | undefined>(() =>
  props.models?.find((m) => m.id === props.status?.modelId),
);
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
const thinkingLevel = computed(() => effectiveThinkingLevel(currentModel.value, props.thinking));
const activeThinkingSegment = computed<string>(() => {
  const segs = thinkingSegments.value;
  return segs.includes(thinkingLevel.value) ? thinkingLevel.value : '';
});
const thinkingOptions = computed(() =>
  thinkingSegments.value.map((seg) => ({ value: seg, label: effortLabel(seg) })),
);
const planOn = computed<boolean>(() => props.planMode === true);
const goalOn = computed<boolean>(() => props.goalMode === true);

function onToggleGoal(): void {
  if (props.goalActive) {
    emit('focusGoal');
    return;
  }
  if (!goalOn.value && planOn.value) emit('togglePlan');
  emit('toggleGoal');
}
function onTogglePlan(): void {
  if (!planOn.value && goalOn.value) emit('toggleGoal');
  emit('togglePlan');
}
const swarmOn = computed<boolean>(() => props.swarmMode === true);
const towerOn = computed<boolean>(() => props.towerMode === true);

const accountLevel = computed(() => props.managedUserInfo?.userLevelName?.trim() ?? '');

const signedIn = computed(() => props.managedProviderStatus === 'authenticated');
const rcMode = isRcLocation(window.location);
const desktopBridge = hasDesktopBridge();

const permColor = computed<string>(() => {
  const p = props.status.permission;
  if (p === 'auto') return 'var(--color-danger)';
  if (p === 'yolo') return 'var(--color-warning)';
  return 'var(--color-text-muted)';
});
const permSub = computed<string>(() => {
  const p = props.status.permission;
  if (p === undefined) return '';
  const desc = p === 'yolo' ? t('mobile.permYoloSub') : p === 'auto' ? t('mobile.permAutoSub') : t('mobile.permManualSub');
  return `${p} · ${desc}`;
});

const ctxPct = computed<number>(() =>
  props.status.ctxMax > 0
    ? Math.min(100, Math.max(0, Math.ceil((props.status.ctxUsed / props.status.ctxMax) * 100)))
    : 0,
);
const ctxValue = computed<string>(() =>
  props.status.ctxMax > 0 ? `${formatTokens(props.status.ctxUsed)}/${formatTokens(props.status.ctxMax)}` : t('status.statusNone'),
);

function setThinkingSegment(value: string): void {
  emit('setThinking', commitLevel(currentModel.value, value));
}

function cyclePermission(): void {
  const idx = props.status.permission === undefined ? -1 : PERM_MODES.indexOf(props.status.permission);
  const next = PERM_MODES[(idx + 1) % PERM_MODES.length]!;
  emit('setPermission', next);
}

function onPickModel(): void {
  emit('pickModel');
  emit('update:modelValue', false);
}

function onLogin(): void {
  emit('login');
  emit('update:modelValue', false);
}

function onLogout(): void {
  emit('logout');
  emit('update:modelValue', false);
}

function toggleAutoSessionTitle(): void {
  const enabled = client.config.value?.autoSessionTitle !== false;
  void client.updateConfig({ autoSessionTitle: !enabled });
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="view === 'providers' ? t('settings.tabs.providers') : t('mobile.settingsTitle')"
    :close-on-esc="!isConfirmOpen && effortSwitchConfirmPending === null && fontPageTarget === null"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="view === 'providers'">
      <button type="button" class="srow back-row" @click="view = 'main'">
        <Icon name="chevron-left" size="sm" aria-hidden="true" />
        <span class="srow-main">
          <span class="srow-label">{{ t('mobile.settingsTitle') }}</span>
        </span>
      </button>
      <div class="providers-page">
        <ProvidersPanel @login="emit('login')" />
      </div>
    </template>
    <div v-else-if="fontPageTarget" class="font-page">
      <FontSettingsPage :key="fontPageTarget" :target="fontPageTarget" source-panel="mobile_settings" @back="fontPage.back()" />
    </div>
    <template v-else>
    <div class="group-title">{{ t('mobile.groupSession') }}</div>
    <div class="card">
      <button type="button" class="srow" @click="onPickModel">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusModel') }}</span>
          <span class="srow-sub">{{ status.model }}</span>
        </span>
        <span class="chev">›</span>
      </button>

      <div class="srow read-only" :class="{ pref: thinkingSegments.length > 2 }">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusThinking') }}</span>
          <span
            v-if="thinkingAvailability === 'unsupported'"
            class="srow-sub"
          >{{ t('status.modeNotSupported') }}</span>
        </span>
        <SegmentedControl
          v-if="thinkingSegments.length > 1"
          :model-value="activeThinkingSegment"
          :options="thinkingOptions"
          size="sm"
          @update:model-value="setThinkingSegment"
        />
        <span
          v-else
          class="srow-val"
          :class="{ dim: thinkingLevel === 'off' }"
        >{{ thinkingLevel === 'off' ? t('status.planOff') : effortLabel(thinkingLevel) }}</span>
      </div>

      <button type="button" class="srow" role="switch" :aria-checked="planOn" @click="onTogglePlan">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusPlanMode') }}</span>
          <span class="srow-sub">{{ t('mobile.planModeSub') }}</span>
        </span>
        <Switch :model-value="planOn" size="lg" decorative />
      </button>

      <button v-if="!goalActive" type="button" class="srow" role="switch" :aria-checked="goalOn" @click="onToggleGoal">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.goalLabel') }}</span>
          <span class="srow-sub">{{ t('mobile.goalModeSub') }}</span>
        </span>
        <Switch :model-value="goalOn" size="lg" decorative />
      </button>
      <button v-else type="button" class="srow" @click="onToggleGoal">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.goalLabel') }}</span>
          <span class="srow-sub">{{ t('mobile.goalModeSub') }}</span>
        </span>
        <Icon class="srow-chevron" name="chevron-right" size="sm" aria-hidden="true" />
      </button>

      <button type="button" class="srow" role="switch" :aria-checked="swarmOn" @click="emit('toggleSwarm')">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusSwarmMode') }}</span>
          <span class="srow-sub">{{ t('mobile.swarmModeSub') }}</span>
        </span>
        <Switch :model-value="swarmOn" size="lg" decorative />
      </button>

      <button v-if="towerEnabled" type="button" class="srow" role="switch" :aria-checked="towerOn" @click="emit('toggleTower')">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusTowerMode') }}</span>
          <span class="srow-sub">{{ t('mobile.towerModeSub') }}</span>
        </span>
        <Switch :model-value="towerOn" size="lg" decorative />
      </button>

      <button type="button" class="srow" @click="cyclePermission">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusPermission') }}</span>
          <span class="srow-sub" :style="{ color: permColor }">{{ permSub }}</span>
        </span>
        <span class="chev">›</span>
      </button>

      <div class="srow read-only">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusContext') }}</span>
          <span class="srow-sub">{{ ctxValue }}</span>
        </span>
        <span class="ctx-meter" :aria-label="ctxValue">
          <i :style="{ width: ctxPct + '%' }" />
        </span>
      </div>
    </div>

    <div class="cache-note">{{ t('status.cacheNote') }}</div>

    <div class="group-title">{{ t('mobile.groupApp') }}</div>
    <div class="card">
      <div class="srow read-only pref">
        <span class="srow-main">
          <span class="srow-label">{{ t('theme.colorSchemeLabel') }}</span>
        </span>
        <SegmentedControl
          :model-value="colorScheme ?? 'system'"
          :options="[
            { value: 'light', label: t('theme.light'), icon: 'light-mode' },
            { value: 'dark', label: t('theme.dark'), icon: 'dark-mode' },
            { value: 'system', label: t('theme.system') },
          ]"
          @update:model-value="onColorScheme"
        />
      </div>

      <div class="srow read-only pref">
        <span class="srow-main">
          <span class="srow-label">{{ t('sidebar.language') }}</span>
        </span>
        <LanguageSwitcher panel="mobile_settings" />
      </div>

      <BrowserTabTitleSetting v-if="!desktopBridge" source-panel="mobile_settings" />

      <div class="srow read-only pref">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.uiFontSize') }}</span>
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
          @update:model-value="emit('setFontScale', $event as FontScale)"
        />
      </div>

      <FontSettingsRow target="ui" @open="fontPage.open" />
      <FontSettingsRow target="transcript" @open="fontPage.open" />
      <FontSettingsRow target="code" @open="fontPage.open" />
      <FontSettingsRow v-if="desktopBridge" target="terminal" @open="fontPage.open" />

      <div
        ref="runningSendRowRef"
        class="srow read-only pref"
        :class="{ 'srow-highlighted': highlightedSetting === 'running-send-mode' }"
        :data-setting-highlighted="highlightedSetting === 'running-send-mode' ? 'true' : undefined"
      >
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.runningSendMode') }}</span>
          <span class="srow-sub">{{ t('settings.runningSendModeHint') }}</span>
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
      <button type="button" class="srow" role="switch" :aria-checked="pasteImageAutoMention" @click="setPasteImageAutoMention(!pasteImageAutoMention)">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.pasteImageAutoMention') }}</span>
          <span class="srow-sub">{{ t('settings.pasteImageAutoMentionHint') }}</span>
        </span>
        <Switch :model-value="pasteImageAutoMention" size="lg" decorative />
      </button>
      <button type="button" class="srow" role="switch" :aria-checked="turnFolding" @click="setTurnFolding(!turnFolding)">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.turnFolding') }}</span>
          <span class="srow-sub">{{ t('settings.turnFoldingHint') }}</span>
        </span>
        <Switch :model-value="turnFolding" size="lg" decorative />
      </button>
      <button type="button" class="srow" role="switch" :aria-checked="activityRunFolding" @click="setActivityRunFolding(!activityRunFolding)">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.activityRunFolding') }}</span>
          <span class="srow-sub">{{ t('settings.activityRunFoldingHint') }}</span>
        </span>
        <Switch :model-value="activityRunFolding" size="lg" decorative />
      </button>
      <button type="button" class="srow" role="switch" :aria-checked="client.config.value?.autoSessionTitle !== false" @click="toggleAutoSessionTitle()">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.autoSessionTitle') }}</span>
          <span class="srow-sub">{{ t('settings.autoSessionTitleHint') }}</span>
        </span>
        <Switch :model-value="client.config.value?.autoSessionTitle !== false" size="lg" decorative />
      </button>

      <div v-if="serverVersion" class="srow read-only">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.serverVersion') }}</span>
        </span>
        <span class="srow-val dim">{{ serverVersion }}</span>
      </div>
    </div>

    <div class="group-title">{{ t('mobile.groupAccount') }}</div>
    <div class="card">
      <template v-if="signedIn">
        <div class="srow read-only acct-profile">
          <Avatar :src="managedUserInfo?.avatar" size="lg" shape="circle" aria-hidden="true" />
          <span class="srow-main">
            <span class="acct-name-row">
              <span class="srow-label">{{ managedUserInfo?.nickname || t('sidebar.defaultUserName') }}</span>
              <Badge v-if="accountLevel" class="acct-level" variant="neutral" size="sm">{{ accountLevel }}</Badge>
            </span>
            <span class="srow-sub">
              {{
                client.hasBusinessWorkspace.value
                  ? client.currentManagedWorkspace.value?.kind === 'business'
                    ? managedUserInfo?.workspaceName || client.currentManagedWorkspace.value.name
                    : managedUserInfo?.workspaceName || t('account.personalWorkspace')
                  : t('settings.signedIn')
              }}
            </span>
          </span>
        </div>
        <button v-if="!rcMode" type="button" class="srow acct out" @click="onLogout">
          <span class="srow-main">
            <span class="srow-label">{{ t('sidebar.signOut') }}</span>
          </span>
        </button>
      </template>
      <button v-else type="button" class="srow acct in" @click="onLogin">
        <span class="srow-main">
          <span class="srow-label">{{ t('sidebar.signIn') }}</span>
        </span>
      </button>
    </div>

    <!-- Plan usage — the Settings dialog's PlanUsageCard, fetching per open.
         desktop fork: its PlanUsageCard requires `active` (view telemetry);
         the sheet mounts the card only while open, so mounted == visible. -->
    <div v-if="signedIn && modelValue" class="usage">
      <PlanUsageCard :on-fetch-usage="client.getUsage" :active="modelValue" />
    </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.group-title {
  padding: var(--space-4) max(var(--space-4), var(--safe-right)) var(--space-2) max(var(--space-4), var(--safe-left));
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.group-title:first-child {
  padding-top: 0;
}

.card {
  margin: 0 max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
  background: var(--color-surface);
  border-radius: var(--radius-xl);
  overflow: hidden;
}
.card > .srow {
  border-radius: 0;
  transition:
    background-color var(--duration-slow) var(--ease-out),
    box-shadow var(--duration-slow) var(--ease-out);
}
.card > .srow:first-child {
  border-top-left-radius: var(--radius-xl);
  border-top-right-radius: var(--radius-xl);
}
.card > .srow:last-child {
  border-bottom-left-radius: var(--radius-xl);
  border-bottom-right-radius: var(--radius-xl);
}
.card > * + .srow {
  border-top: var(--p-hairline) solid var(--color-line);
}
.card > .srow.srow-highlighted {
  position: relative;
  z-index: 1;
  background-color: var(--color-accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--color-accent-bd);
  animation: ui-row-highlight var(--duration-flash) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .card > .srow {
    transition: none;
  }
  .card > .srow.srow-highlighted {
    animation: none;
  }
}

.srow:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.srow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-3) var(--space-4);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
}
.srow:hover:not(.read-only) { background: var(--color-hover); }
.srow:active:not(.read-only) { background: var(--color-surface-sunken); }
.srow.read-only { cursor: default; }

.srow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srow-label { font-size: var(--text-base); color: var(--color-text); }
.srow-sub {
  font-size: var(--text-base);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}

.back-row {
  min-height: var(--touch-target-min);
  color: var(--color-text-muted);
}
.back-row:hover {
  color: var(--color-text);
}
.font-page {
  margin: 0 max(var(--space-4), var(--safe-right)) var(--space-4) max(var(--space-4), var(--safe-left));
}
.providers-page {
  margin: 0 max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
}
.providers-page :deep(.pp-head .sec-title) {
  display: none;
}
.srow-val {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-accent-hover);
}
.srow-val.dim {
  font-weight: 400;
  color: var(--color-text-muted);
}

.cache-note {
  padding: var(--space-1) max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: 1.4;
}

.chev {
  flex: none;
  color: var(--color-text-faint);
  font-size: 17px;
  line-height: 1;
}

.srow.pref {
  flex-wrap: wrap;
  cursor: default;
}
.srow.pref .srow-main {
  flex: 1 0 100%;
}

.srow.acct.in .srow-label { color: var(--color-accent-hover); font-weight: 500; }
.srow.acct.out .srow-label { color: var(--color-danger); }
.acct-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.acct-name-row .srow-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acct-level {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.usage {
  margin: var(--space-4) max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
}
.usage :deep(.sec) {
  margin-bottom: 0;
}

.ctx-meter {
  flex: none;
  width: 96px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
}
.ctx-meter i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.srow,
.srow-sub,
.srow-val,
.cache-note { font-family: var(--font-ui); }
</style>
