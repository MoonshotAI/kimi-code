<!-- Mobile settings bottom sheet, grouped the way the desktop Settings dialog -->
<!-- is: a "Current session" card (model → ModelPicker, thinking segments, plan -->
<!-- / swarm toggles, permission, read-only context meter + cache note), an -->
<!-- "App preferences" card (color scheme / language / font size / server -->
<!-- version), and an "Account" module (profile card with sign in/out, then the -->
<!-- shared PlanUsageCard) — hairline-separated rows in rounded surface cards, -->
<!-- the Settings dialog's settings-group shell vocabulary. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../../types';
import type { AppModel, ManagedUserInfo, ThinkingLevel } from '../../api/types';
import type { ColorScheme, FontScale } from '@moonshot-ai/app-client/client';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import {
  commitLevel,
  effectiveThinkingLevel,
  effortLabel,
  modelThinkingAvailability,
  segmentsFor,
} from '@moonshot-ai/app-core/lib';
import { BottomSheet } from '@moonshot-ai/app-components';
import LanguageSwitcher from '../settings/LanguageSwitcher.vue';
import PlanUsageCard from '../settings/PlanUsageCard.vue';
import { formatTokens } from '@moonshot-ai/app-core/lib';
import { Badge, Icon, SegmentedControl } from '@moonshot-ai/app-ui';

const { t } = useI18n();

// A stacked global confirm (e.g. sign-out) owns Escape while it's open.
const { isConfirmOpen } = useConfirmDialog();

const client = useKimiWebClient();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    status: ConversationStatus;
    thinking?: ThinkingLevel;
    planMode?: boolean;
    goalMode?: boolean;
    /** A goal is live in this session (active/paused/blocked) — the goal row
        then focuses its panel instead of arming a new one. */
    goalActive?: boolean;
    swarmMode?: boolean;
    colorScheme?: ColorScheme;
    fontScale?: FontScale;
    /** Managed Kimi account credential state from GET /api/v1/auth — drives the
        account module (third-party providers must not keep it "signed in"
        after a Kimi logout). */
    managedProviderStatus?: string | null;
    /** Signed-in managed-account profile (GET /oauth/userinfo) — avatar +
        nickname on the account row; absent while loading or on older daemons. */
    managedUserInfo?: ManagedUserInfo | null;
    /** Server version from GET /api/v1/meta, shown as a read-only row. */
    serverVersion?: string;
    /** Available models — used to derive the current model's thinking segments. */
    models?: AppModel[];
  }>(),
  {
    colorScheme: 'system',
    fontScale: 'medium',
    managedProviderStatus: null,
    managedUserInfo: null,
    serverVersion: '',
    models: () => [],
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  pickModel: [];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleGoal: [];
  focusGoal: [];
  toggleSwarm: [];
  setPermission: [mode: PermissionMode];
  setColorScheme: [colorScheme: ColorScheme];
  setFontScale: [scale: FontScale];
  login: [];
  logout: [];
}>();

function onColorScheme(v: string): void {
  emit('setColorScheme', v as ColorScheme);
}

// Escalating autonomy order, matching the Composer's permission menu:
// manual < yolo (auto-approves tools) < auto (fully autonomous).
const PERM_MODES: PermissionMode[] = ['manual', 'yolo', 'auto'];

// Identity is the model id — display/model names can collide across providers.
const currentModel = computed<AppModel | undefined>(() =>
  props.models?.find((m) => m.id === props.status?.modelId),
);
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
// The client resolves the level per model (the model's stored pick when still
// declared, else the catalog default), so what arrives here is valid for the
// active model. An undeclared level can only appear transiently, before the
// catalog loads, and simply highlights no segment.
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

// The two primary work modes are mutually exclusive — arming one disarms the
// other, mirroring Composer's armPlanMode/armGoalMode.
function onToggleGoal(): void {
  // Mirror Composer.armGoalMode further: a live goal owns the mode — focus
  // its panel instead of starting a new one.
  if (props.goalActive) {
    emit('focusGoal');
    return;
  }
  if (!goalOn.value && planOn.value) emit('togglePlan');
  emit('toggleGoal');
}
function onTogglePlan(): void {
  // Mirror Composer.armPlanMode: the two primary modes swap each other out.
  if (!planOn.value && goalOn.value) emit('toggleGoal');
  emit('togglePlan');
}
const swarmOn = computed<boolean>(() => props.swarmMode === true);

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

// Server-supplied level label (may be ''), shown as a badge next to the name.
const accountLevel = computed(() => props.managedUserInfo?.userLevelName?.trim() ?? '');

const signedIn = computed(() => props.managedProviderStatus === 'authenticated');

// Same escalation colours as the Composer's permission menu: yolo is the
// warning level, auto (fully autonomous, never asks) is the danger level.
const permColor = computed<string>(() => {
  const p = props.status.permission;
  if (p === 'auto') return 'var(--color-danger)';
  if (p === 'yolo') return 'var(--color-warning)';
  return 'var(--color-text-muted)';
});
/** Permission sub-line, e.g. "manual · confirm every tool". */
const permSub = computed<string>(() => {
  const p = props.status.permission;
  const desc = p === 'yolo' ? t('mobile.permYoloSub') : p === 'auto' ? t('mobile.permAutoSub') : t('mobile.permManualSub');
  return `${p} · ${desc}`;
});

const ctxPct = computed<number>(() =>
  // ceil (not round) so sub-0.5% usage still renders a visible bar sliver.
  props.status.ctxMax > 0
    ? Math.min(100, Math.max(0, Math.ceil((props.status.ctxUsed / props.status.ctxMax) * 100)))
    : 0,
);
// Shared 1024-based formatter, same as the desktop tooltip / status panel.
const ctxValue = computed<string>(() =>
  props.status.ctxMax > 0 ? `${formatTokens(props.status.ctxUsed)}/${formatTokens(props.status.ctxMax)}` : t('status.statusNone'),
);

function setThinkingSegment(value: string): void {
  emit('setThinking', commitLevel(currentModel.value, value));
}

function cyclePermission(): void {
  const idx = PERM_MODES.indexOf(props.status.permission);
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
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="t('mobile.settingsTitle')"
    :close-on-esc="!isConfirmOpen"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- ======================= Current session ======================= -->
    <div class="group-title">{{ t('mobile.groupSession') }}</div>
    <div class="card">
      <!-- Model → opens ModelPicker -->
      <button type="button" class="srow" @click="onPickModel">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusModel') }}</span>
          <span class="srow-sub">{{ status.model }}</span>
        </span>
        <span class="chev">›</span>
      </button>

      <!-- Thinking level → segmented control (or read-only value when single/unsupported) -->
      <div class="srow read-only">
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

      <!-- Plan mode → real toggle switch -->
      <button type="button" class="srow" role="switch" :aria-checked="planOn" @click="onTogglePlan">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusPlanMode') }}</span>
          <span class="srow-sub">{{ t('mobile.planModeSub') }}</span>
        </span>
        <span class="toggle" :class="{ on: planOn }" aria-hidden="true" />
      </button>

      <!-- Goal: a switch only while genuinely toggleable (armed, no live goal);
           with a live goal the row navigates to the goal's panel instead — a
           switch that "doesn't switch" would lie to AT. -->
      <button v-if="!goalActive" type="button" class="srow" role="switch" :aria-checked="goalOn" @click="onToggleGoal">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.goalLabel') }}</span>
          <span class="srow-sub">{{ t('mobile.goalModeSub') }}</span>
        </span>
        <span class="toggle" :class="{ on: goalOn }" aria-hidden="true" />
      </button>
      <button v-else type="button" class="srow" @click="onToggleGoal">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.goalLabel') }}</span>
          <span class="srow-sub">{{ t('mobile.goalModeSub') }}</span>
        </span>
        <Icon class="srow-chevron" name="chevron-right" size="sm" aria-hidden="true" />
      </button>

      <!-- Swarm mode → real toggle switch -->
      <button type="button" class="srow" role="switch" :aria-checked="swarmOn" @click="emit('toggleSwarm')">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusSwarmMode') }}</span>
          <span class="srow-sub">{{ t('mobile.swarmModeSub') }}</span>
        </span>
        <span class="toggle" :class="{ on: swarmOn }" aria-hidden="true" />
      </button>

      <!-- Permission → cycle (sub-line + chevron) -->
      <button type="button" class="srow" @click="cyclePermission">
        <span class="srow-main">
          <span class="srow-label">{{ t('status.statusPermission') }}</span>
          <span class="srow-sub" :style="{ color: permColor }">{{ permSub }}</span>
        </span>
        <span class="chev">›</span>
      </button>

      <!-- Context usage → read-only mini meter + value -->
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

    <!-- Prompt-cache invalidation note — same text as the desktop model
         dropdown, covering both the model and thinking rows above. -->
    <div class="cache-note">{{ t('status.cacheNote') }}</div>

    <!-- ======================= App preferences ======================= -->
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

      <div class="srow read-only pref">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.uiFontSize') }}</span>
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
          @update:model-value="emit('setFontScale', $event as FontScale)"
        />
      </div>

      <!-- Server version -->
      <div v-if="serverVersion" class="srow read-only">
        <span class="srow-main">
          <span class="srow-label">{{ t('settings.serverVersion') }}</span>
        </span>
        <span class="srow-val dim">{{ serverVersion }}</span>
      </div>
    </div>

    <!-- ======================= Account ======================= -->
    <div class="group-title">{{ t('mobile.groupAccount') }}</div>
    <div class="card">
      <template v-if="signedIn">
        <!-- Signed-in profile -->
        <div class="srow read-only acct-profile">
          <span class="acct-avatar" aria-hidden="true">
            <img v-if="showAvatar" :src="managedUserInfo?.avatar" alt="" @error="avatarLoadFailed = true" />
            <Icon v-else name="user" size="md" />
          </span>
          <span class="srow-main">
            <span class="acct-name-row">
              <span class="srow-label">{{ managedUserInfo?.nickname || t('sidebar.defaultUserName') }}</span>
              <Badge v-if="accountLevel" class="acct-level" variant="neutral" size="sm">{{ accountLevel }}</Badge>
            </span>
            <span class="srow-sub">{{ t('settings.signedIn') }}</span>
          </span>
        </div>
        <button type="button" class="srow acct out" @click="onLogout">
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
  </BottomSheet>
</template>

<style scoped>
/* Section titles — the Settings dialog's .sec-title vocabulary. */
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

/* Rounded surface card per group (the Settings dialog's settings-group /
   PlanUsageCard pu-group shell): rows hairline-separated inside. */
.card {
  margin: 0 max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
  background: var(--color-surface);
  border-radius: var(--radius-xl);
  overflow: hidden;
}
.card > .srow {
  border-radius: 0;
}
.card > .srow + .srow {
  border-top: 0.5px solid var(--color-line);
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
.srow-val {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--ui-font-size);
  font-weight: 500;
  color: var(--color-accent-hover);
}
.srow-val.dim {
  font-weight: 400;
  color: var(--color-text-muted);
}

/* Prompt-cache note under the session card — mirrors .md-cache-note in Composer. */
.cache-note {
  padding: var(--space-1) max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: 1.4;
}

/* Chevron (prototype ›) — fixed icon glyph size, not part of UI font scale. */
.chev {
  flex: none;
  color: var(--color-text-faint);
  font-size: 17px;
  line-height: 1;
}

/* Plan toggle (44×26 prototype) */
.toggle {
  flex: none;
  width: 44px;
  height: 26px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  position: relative;
  transition: background 0.18s;
}
.toggle.on { background: var(--color-accent); }
.toggle::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  box-sizing: border-box;
  background: var(--color-bg);
  border: 0.5px solid var(--color-line);
  box-shadow: var(--shadow-xs);
  transition: left 0.18s;
}
.toggle.on::after { left: 21px; }

/* App preference rows: label line above the control (segmented / switcher). */
.srow.pref {
  flex-wrap: wrap;
  cursor: default;
}
.srow.pref .srow-main {
  flex: 1 0 100%;
}

/* Account rows */
.srow.acct.in .srow-label { color: var(--color-accent-hover); font-weight: 500; }
.srow.acct.out .srow-label { color: var(--color-danger); }
.acct-avatar {
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
.acct-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
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

/* Plan usage module — aligned with the cards. */
.usage {
  margin: var(--space-4) max(var(--space-4), var(--safe-right)) 0 max(var(--space-4), var(--safe-left));
}
.usage :deep(.sec) {
  margin-bottom: 0;
}

/* Context meter (96px prototype) */
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
.cache-note { font-family: var(--sans); }
</style>
