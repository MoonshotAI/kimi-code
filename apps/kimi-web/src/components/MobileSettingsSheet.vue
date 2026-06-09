<!-- apps/kimi-web/src/components/MobileSettingsSheet.vue -->
<!-- Mobile settings: a bottom sheet that surfaces the desktop Composer-toolbar -->
<!-- controls as big tappable rows — model (opens ModelPicker), thinking level -->
<!-- (inline cycle picker), plan mode (toggle), permission (cycle), and a -->
<!-- read-only context-usage meter — plus the desktop settings-popover prefs -->
<!-- (theme / accent / language) and the sign-in/out entry, which previously -->
<!-- had no mobile counterpart. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../types';
import type { ThinkingLevel } from '../api/types';
import type { Accent, Theme } from '../composables/useKimiWebClient';
import BottomSheet from './BottomSheet.vue';
import LanguageSwitcher from './LanguageSwitcher.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    status: ConversationStatus;
    thinking?: ThinkingLevel;
    planMode?: boolean;
    theme?: Theme;
    accent?: Accent;
    authReady?: boolean;
  }>(),
  { theme: 'terminal', accent: 'blue', authReady: false },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  pickModel: [];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  setPermission: [mode: PermissionMode];
  setTheme: [theme: Theme];
  setAccent: [accent: Accent];
  login: [];
  logout: [];
}>();

const PERM_MODES: PermissionMode[] = ['manual', 'auto', 'yolo'];

const thinkingLevel = computed<ThinkingLevel>(() => props.thinking ?? 'high');
const planOn = computed<boolean>(() => props.planMode === true);

const permColor = computed<string>(() => {
  const p = props.status.permission;
  if (p === 'yolo') return 'var(--err)';
  if (p === 'auto') return 'var(--warn)';
  return 'var(--faint)';
});
/** Permission sub-line, e.g. "manual · confirm every tool". */
const permSub = computed<string>(() => {
  const p = props.status.permission;
  const desc = p === 'yolo' ? t('mobile.permYoloSub') : p === 'auto' ? t('mobile.permAutoSub') : t('mobile.permManualSub');
  return `${p} · ${desc}`;
});

const kFmt = (n: number): string => `${Math.round(n / 1000)}k`;
const ctxPct = computed<number>(() =>
  props.status.ctxMax > 0 ? Math.round((props.status.ctxUsed / props.status.ctxMax) * 100) : 0,
);
const ctxValue = computed<string>(() =>
  props.status.ctxMax > 0 ? `${kFmt(props.status.ctxUsed)} / ${kFmt(props.status.ctxMax)}` : t('status.statusNone'),
);

function cycleThinking(): void {
  // On/off toggle (TUI parity). 'high' = the backend default effort.
  emit('setThinking', thinkingLevel.value === 'off' ? 'high' : 'off');
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
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- Model → opens ModelPicker -->
    <button type="button" class="srow" @click="onPickModel">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusModel') }}</span>
        <span class="srow-sub">{{ status.model }}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <!-- Thinking level → inline cycle (value + chevron) -->
    <button type="button" class="srow" @click="cycleThinking">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusThinking') }}</span>
      </span>
      <span class="srow-val">{{ thinkingLevel === 'off' ? t('status.planOff') : t('status.planOn') }}</span>
      <span class="chev">›</span>
    </button>

    <!-- Plan mode → real toggle switch -->
    <button type="button" class="srow" @click="emit('togglePlan')">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusPlanMode') }}</span>
        <span class="srow-sub">{{ t('mobile.planModeSub') }}</span>
      </span>
      <span class="toggle" :class="{ on: planOn }" role="switch" :aria-checked="planOn" />
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

    <!-- App preferences (the desktop settings-popover controls) -->
    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('theme.label') }}</span>
      </span>
      <div class="seg" role="group" :aria-label="t('theme.label')">
        <button
          type="button"
          class="seg-opt"
          :class="{ on: theme === 'modern' }"
          :aria-pressed="theme === 'modern'"
          @click="emit('setTheme', 'modern')"
        >{{ t('theme.modern') }}</button>
        <button
          type="button"
          class="seg-opt"
          :class="{ on: theme === 'terminal' }"
          :aria-pressed="theme === 'terminal'"
          @click="emit('setTheme', 'terminal')"
        >{{ t('theme.terminal') }}</button>
      </div>
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('theme.accentLabel') }}</span>
      </span>
      <div class="seg" role="group" :aria-label="t('theme.accentLabel')">
        <button
          type="button"
          class="seg-opt"
          :class="{ on: accent === 'blue' }"
          :aria-pressed="accent === 'blue'"
          @click="emit('setAccent', 'blue')"
        >{{ t('theme.accentBlue') }}</button>
        <button
          type="button"
          class="seg-opt"
          :class="{ on: accent === 'mono' }"
          :aria-pressed="accent === 'mono'"
          @click="emit('setAccent', 'mono')"
        >{{ t('theme.accentMono') }}</button>
      </div>
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.language') }}</span>
      </span>
      <LanguageSwitcher />
    </div>

    <!-- Account: sign in / out -->
    <button v-if="authReady" type="button" class="srow acct out" @click="onLogout">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.signOut') }}</span>
      </span>
    </button>
    <button v-else type="button" class="srow acct in" @click="onLogin">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.signIn') }}</span>
      </span>
    </button>
  </BottomSheet>
</template>

<style scoped>
.srow {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 15px 16px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line2);
  cursor: pointer;
  font-family: var(--mono);
  text-align: left;
  color: var(--ink);
}
.srow:active:not(.read-only) { background: var(--panel); }
.srow.read-only { cursor: default; }

.srow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srow-label { font-size: 13.5px; color: var(--ink); }
.srow-sub {
  font-size: 11.5px;
  color: var(--faint);
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow-val {
  flex: none;
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--blue2);
}

/* Chevron (prototype ›) */
.chev {
  flex: none;
  color: var(--faint);
  font-size: 17px;
  line-height: 1;
}

/* Plan toggle (44×26 prototype) */
.toggle {
  flex: none;
  width: 44px;
  height: 26px;
  border-radius: 14px;
  background: var(--line);
  position: relative;
  transition: background 0.18s;
}
.toggle.on { background: var(--blue); }
.toggle::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: left 0.18s;
}
.toggle.on::after { left: 21px; }

/* App preference rows: segmented theme/accent toggles + language switcher. */
.srow.pref { cursor: default; }
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
  flex: none;
}
.seg-opt {
  border: none;
  background: none;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  padding: 7px 14px;
  line-height: 1.4;
}
.seg-opt + .seg-opt { border-left: 1px solid var(--line); }
.seg-opt.on {
  background: var(--soft);
  color: var(--blue2);
  font-weight: 600;
}

/* Account rows */
.srow.acct.in .srow-label { color: var(--blue2); font-weight: 600; }
.srow.acct.out .srow-label { color: var(--err); }

/* Context meter (96px prototype) */
.ctx-meter {
  flex: none;
  width: 96px;
  height: 7px;
  border-radius: 4px;
  background: var(--panel2);
  overflow: hidden;
}
.ctx-meter i {
  display: block;
  height: 100%;
  background: var(--blue);
}
</style>
