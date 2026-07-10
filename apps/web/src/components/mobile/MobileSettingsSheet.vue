<!-- apps/kimi-web/src/components/mobile/MobileSettingsSheet.vue -->
<!-- Mobile settings: a bottom sheet that surfaces the desktop Composer-toolbar -->
<!-- controls as big tappable rows — model (opens ModelPicker), thinking level -->
<!-- (inline cycle picker), plan mode (toggle), permission (cycle), and a -->
<!-- read-only context-usage meter — plus the desktop settings-popover prefs -->
<!-- (theme / color scheme / language) and the sign-in/out entry, which previously -->
<!-- had no mobile counterpart. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../../types';
import type { AppModel, AppSession, ThinkingLevel } from '../../api/types';
import type { ColorScheme } from '../../composables/useKimiWebClient';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import {
  coerceThinkingForModel,
  commitLevel,
  effortLabel,
  modelThinkingAvailability,
  segmentsFor,
} from '../../lib/modelThinking';
import BottomSheet from '../dialogs/BottomSheet.vue';
import LanguageSwitcher from '../settings/LanguageSwitcher.vue';
import Button from '../ui/Button.vue';
import Input from '../ui/Input.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    status: ConversationStatus;
    thinking?: ThinkingLevel;
    planMode?: boolean;
    swarmMode?: boolean;
    colorScheme?: ColorScheme;
    uiFontSize?: number;
    authReady?: boolean;
    conversationToc?: boolean;
    /** Server version from GET /api/v1/meta, shown as a read-only row. */
    serverVersion?: string;
    /** Available models — used to derive the current model's thinking segments. */
    models?: AppModel[];
  }>(),
  {
    colorScheme: 'system',
    uiFontSize: 14,
    authReady: false,
    serverVersion: '',
    models: () => [],
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  pickModel: [];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  setPermission: [mode: PermissionMode];
  setColorScheme: [colorScheme: ColorScheme];
  setUiFontSize: [size: number];
  setConversationToc: [on: boolean];
  login: [];
  logout: [];
}>();

function onColorScheme(v: string): void {
  emit('setColorScheme', v as ColorScheme);
}

const PERM_MODES: PermissionMode[] = ['manual', 'auto', 'yolo'];

const currentModel = computed<AppModel | undefined>(() => {
  const raw = props.status?.modelId ?? props.status?.model ?? '';
  return props.models?.find(
    (m) => m.id === raw || m.model === raw || m.displayName === props.status?.model,
  );
});
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
// The persisted level can be stale relative to the active model (e.g. 'on'
// from a boolean model, or 'off' while viewing an always-on effort model).
// Coerce it before computing the active segment so the mobile sheet shows and
// selects the same model-aware default the composer and prompt submission use.
const coercedThinkingLevel = computed(() =>
  coerceThinkingForModel(currentModel.value, props.thinking ?? 'off'),
);
// Runtime level clamped to the segments this model actually offers.
const activeThinkingSegment = computed<string>(() => {
  const segs = thinkingSegments.value;
  const level = coercedThinkingLevel.value;
  if (segs.includes(level)) return level;
  if (segs.includes('on')) return 'on';
  return segs[0] ?? 'off';
});
const thinkingOptions = computed(() =>
  thinkingSegments.value.map((seg) => ({ value: seg, label: effortLabel(seg) })),
);
const planOn = computed<boolean>(() => props.planMode === true);
const swarmOn = computed<boolean>(() => props.swarmMode === true);

const permColor = computed<string>(() => {
  const p = props.status.permission;
  if (p === 'yolo') return 'var(--color-danger)';
  if (p === 'auto') return 'var(--color-warning)';
  return 'var(--color-text-muted)';
});
/** Permission sub-line, e.g. "manual · confirm every tool". */
const permSub = computed<string>(() => {
  const p = props.status.permission;
  const desc = p === 'yolo' ? t('mobile.permYoloSub') : p === 'auto' ? t('mobile.permAutoSub') : t('mobile.permManualSub');
  return `${p} · ${desc}`;
});

const kFmt = (n: number): string => `${Math.round(n / 1000)}k`;
const ctxPct = computed<number>(() =>
  props.status.ctxMax > 0
    ? Math.min(100, Math.max(0, Math.round((props.status.ctxUsed / props.status.ctxMax) * 100)))
    : 0,
);
// Same "12k/256k" format as the desktop toolbar ring.
const ctxValue = computed<string>(() =>
  props.status.ctxMax > 0 ? `${kFmt(props.status.ctxUsed)}/${kFmt(props.status.ctxMax)}` : t('status.statusNone'),
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

// ---------------------------------------------------------------------------
// Archived-sessions sub-view — mirrors the desktop Settings "Archived" tab so
// the mobile archive confirmation (which points users to Settings to restore)
// is true here too. Loads all archived sessions once when the view opens;
// search + sort run client-side over the full set.
// ---------------------------------------------------------------------------
const client = useKimiWebClient();
type SheetView = 'main' | 'archived';
const view = ref<SheetView>('main');

const archivedItems = ref<AppSession[]>([]);
const archivedLoading = ref(false);
const archivedLoaded = ref(false);
const archiveQuery = ref('');
const archiveSort = ref<'archived-desc' | 'created-desc' | 'name-asc'>('archived-desc');

const ARCHIVED_PAGE_SIZE = 100;

async function loadAllArchived(): Promise<void> {
  if (archivedLoading.value) return;
  archivedLoading.value = true;
  archivedLoaded.value = false;
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
    console.warn('loadAllArchived failed', err);
  } finally {
    archivedLoading.value = false;
  }
}

function openArchived(): void {
  view.value = 'archived';
  archiveQuery.value = '';
  void loadAllArchived();
}

function backToMain(): void {
  view.value = 'main';
}

const filteredArchived = computed<AppSession[]>(() => {
  const q = archiveQuery.value.trim().toLowerCase();
  let rows = archivedItems.value.filter((s) => s.archived === true);
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

async function onRestore(id: string): Promise<void> {
  const ok = await client.restoreSession(id);
  if (ok) archivedItems.value = archivedItems.value.filter((s) => s.id !== id);
}

function archiveTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Reset to the main view whenever the sheet is closed, so reopening starts at
// the top rather than mid-list.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) view.value = 'main';
  },
);
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="t('mobile.settingsTitle')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="view === 'main'">
    <div class="group-title">{{ t('mobile.groupSession') }}</div>

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
        :class="{ dim: activeThinkingSegment === 'off' }"
      >{{ activeThinkingSegment === 'off' ? t('status.planOff') : effortLabel(activeThinkingSegment) }}</span>
    </div>

    <!-- Plan mode → real toggle switch -->
    <button type="button" class="srow" @click="emit('togglePlan')">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusPlanMode') }}</span>
        <span class="srow-sub">{{ t('mobile.planModeSub') }}</span>
      </span>
      <span class="toggle" :class="{ on: planOn }" role="switch" :aria-checked="planOn" />
    </button>

    <!-- Swarm mode → real toggle switch -->
    <button type="button" class="srow" @click="emit('toggleSwarm')">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusSwarmMode') }}</span>
        <span class="srow-sub">{{ t('mobile.swarmModeSub') }}</span>
      </span>
      <span class="toggle" :class="{ on: swarmOn }" role="switch" :aria-checked="swarmOn" />
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

    <div class="group-title">{{ t('mobile.groupApp') }}</div>

    <!-- Archived sessions → opens the archived restore sub-view -->
    <button type="button" class="srow" @click="openArchived">
      <span class="srow-main">
        <span class="srow-label">{{ t('mobile.archivedSessions') }}</span>
        <span class="srow-sub">{{ t('mobile.archivedSessionsSub') }}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <!-- App preferences (the desktop settings-popover controls) -->
    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('theme.colorSchemeLabel') }}</span>
      </span>
      <SegmentedControl
        :model-value="colorScheme ?? 'system'"
        :options="[
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
          { value: 'system', label: t('theme.system') },
        ]"
        @update:model-value="onColorScheme"
      />
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.language') }}</span>
      </span>
      <LanguageSwitcher />
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.uiFontSize') }}</span>
      </span>
      <label class="num-field">
        <input
          class="num-input"
          type="number"
          min="12"
          max="20"
          step="1"
          :value="uiFontSize"
          :aria-label="t('settings.uiFontSize')"
          @input="emit('setUiFontSize', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="num-unit">px</span>
      </label>
    </div>

    <button type="button" class="srow" @click="emit('setConversationToc', !conversationToc)">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.conversationToc') }}</span>
        <span class="srow-sub">{{ t('settings.conversationTocHint') }}</span>
      </span>
      <span class="toggle" :class="{ on: conversationToc }" role="switch" :aria-checked="conversationToc" />
    </button>

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

    <!-- Server version -->
    <div v-if="serverVersion" class="srow read-only">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.serverVersion') }}</span>
      </span>
      <span class="srow-val dim">{{ serverVersion }}</span>
    </div>
    </template>

    <template v-else>
      <!-- Archived sessions sub-view -->
      <div class="arch-subhead">
        <button type="button" class="arch-back" @click="backToMain">
          <span class="chev back">‹</span> {{ t('mobile.archivedBack') }}
        </button>
        <span class="arch-count">{{ t('mobile.sessionCount', { n: filteredArchived.length }) }}</span>
      </div>

      <div class="arch-tools">
        <Input
          class="arch-search-input"
          :model-value="archiveQuery"
          size="sm"
          :placeholder="t('settings.archivedSearch')"
          @update:model-value="archiveQuery = $event"
        />
        <SegmentedControl
          size="sm"
          :model-value="archiveSort"
          :options="[
            { value: 'archived-desc', label: t('settings.archivedSortArchived') },
            { value: 'created-desc', label: t('settings.archivedSortCreated') },
            { value: 'name-asc', label: t('settings.archivedSortName') },
          ]"
          @update:model-value="archiveSort = $event as 'archived-desc' | 'created-desc' | 'name-asc'"
        />
      </div>

      <div v-if="archivedLoading" class="arch-empty">{{ t('settings.archivedLoadingAll') }}</div>

      <template v-else-if="filteredArchived.length > 0">
        <div v-for="s in filteredArchived" :key="s.id" class="arch-row">
          <div class="arch-meta">
            <div class="arch-name">{{ s.title }}</div>
            <div class="arch-time">{{ t('settings.archivedAt', { time: archiveTime(s.updatedAt) }) }}</div>
          </div>
          <Button variant="secondary" size="sm" @click="onRestore(s.id)">{{ t('settings.archivedRestore') }}</Button>
        </div>
      </template>

      <div v-else class="arch-empty">
        {{ archivedItems.length === 0 ? t('settings.archivedEmpty') : t('settings.archivedNoMatch') }}
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.group-title {
  padding: var(--space-3) var(--space-3) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.srow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
}
.srow:hover:not(.read-only) { background: var(--color-surface-sunken); }
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border: 1px solid var(--color-line);
  box-shadow: var(--shadow-xs);
  transition: left 0.18s;
}
.toggle.on::after { left: 21px; }

/* App preference rows: segmented theme/color-scheme toggles + language switcher. */
.srow.pref { cursor: default; }

.num-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}
.num-input {
  width: 50px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--ui-font-size);
  text-align: right;
}
.num-unit {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--ui-font-size-xs);
}

/* Account rows */
.srow.acct.in .srow-label { color: var(--color-accent-hover); font-weight: 500; }
.srow.acct.out .srow-label { color: var(--color-danger); }

/* Context meter (96px prototype) */
.ctx-meter {
  flex: none;
  width: 96px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  overflow: hidden;
}
.ctx-meter i {
  display: block;
  height: 100%;
  background: var(--color-accent);
}

@media (max-width: 640px) {
  .srow {
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    padding: 14px max(14px, env(safe-area-inset-right)) 14px max(14px, env(safe-area-inset-left));
  }
  .group-title {
    padding-left: max(14px, env(safe-area-inset-left));
    padding-right: max(14px, env(safe-area-inset-right));
  }
  .srow-main {
    flex: 1 1 auto;
  }
  .srow-sub {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .srow.pref {
    flex-wrap: wrap;
  }
  .srow.pref .srow-main {
    flex: 1 0 100%;
  }
  .num-field {
    margin-left: auto;
  }
  .srow-val,
  .chev,
  .toggle,
  .ctx-meter {
    margin-top: 2px;
  }
}

.srow,
.srow-sub,
.srow-val { font-family: var(--sans); }

/* Archived sessions sub-view */
.arch-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3) var(--space-1);
}
.arch-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  padding: var(--space-1) var(--space-2) var(--space-1) 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-accent-hover);
  cursor: pointer;
}
.chev.back { font-size: 20px; }
.arch-count {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.arch-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  flex-wrap: wrap;
}
.arch-search-input { flex: 1; min-width: 160px; }
.arch-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 56px;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-line);
}
.arch-row:first-of-type { border-top: none; }
.arch-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.arch-name {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arch-time {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.arch-empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
</style>
