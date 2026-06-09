<!-- apps/kimi-web/src/components/StatusLine.vue -->
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivityState, ConnectionState, ConversationStatus, PermissionMode } from '../types';
import type { ThinkingLevel } from '../api/types';

const { t } = useI18n();

const props = defineProps<{
  status: ConversationStatus;
  connection?: ConnectionState;
  activity?: ActivityState;
  thinking?: ThinkingLevel;
  planMode?: boolean;
}>();

const emit = defineEmits<{
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  compact: [];
  interrupt: [];
  pickModel: [];
}>();

const kFmt = (n: number) => `${Math.round(n / 1000)}k`;

const pct = computed(() => Math.round((props.status.ctxUsed / props.status.ctxMax) * 100) || 0);

const showCompact = computed(() => pct.value >= 80);

const ctxTooltip = computed(() => {
  const used = props.status.ctxUsed.toLocaleString();
  const max = props.status.ctxMax.toLocaleString();
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

// ---------------------------------------------------------------------------
// Popover open/close — only one popover open at a time. Close on outside click.
// ---------------------------------------------------------------------------

type Popover = 'perm' | 'thinking' | null;
const openPopover = ref<Popover>(null);

function toggle(p: Exclude<Popover, null>): void {
  openPopover.value = openPopover.value === p ? null : p;
  if (openPopover.value) {
    document.addEventListener('click', onDocClick, true);
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

const rootRef = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent): void {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    closePopover();
  }
}
function closePopover(): void {
  openPopover.value = null;
  document.removeEventListener('click', onDocClick, true);
}
onUnmounted(() => document.removeEventListener('click', onDocClick, true));

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

function permLabelFor(p: PermissionMode): string {
  if (p === 'yolo') return t('status.permissionYolo');
  if (p === 'auto') return t('status.permissionAuto');
  return t('status.permissionManual');
}
const permLabel = computed(() => permLabelFor(props.status.permission));

const PERM_MODES: { mode: PermissionMode; color: string; descKey: string }[] = [
  { mode: 'manual', color: 'var(--dim)', descKey: 'status.permissionManualDesc' },
  { mode: 'auto', color: 'var(--warn)', descKey: 'status.permissionAutoDesc' },
  { mode: 'yolo', color: 'var(--err)', descKey: 'status.permissionYoloDesc' },
];

function choosePermission(mode: PermissionMode): void {
  emit('setPermission', mode);
  closePopover();
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

const thinkingLevel = computed<ThinkingLevel>(() => props.thinking ?? 'high');
// Thinking is a simple on/off toggle (TUI parity — the TUI treats thinking as a
// boolean and lets the backend pick the effort, default 'high'). We intentionally
// don't expose the 6 effort levels here.
const thinkingOn = computed(() => thinkingLevel.value !== 'off');
function toggleThinking(): void {
  emit('setThinking', thinkingOn.value ? 'off' : 'high');
}

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------

const planOn = computed(() => props.planMode === true);

// ---------------------------------------------------------------------------
// Connection / activity
// ---------------------------------------------------------------------------

const isConnected = computed(() => (props.connection ?? 'disconnected') === 'connected');

const connTitle = computed(() => {
  const c = props.connection ?? 'disconnected';
  if (c === 'connected') return t('status.connectionConnected');
  if (c === 'connecting') return t('status.connectionConnecting');
  return t('status.connectionDisconnected');
});

const activityText = computed(() => {
  const a = props.activity ?? 'idle';
  if (a === 'running') return t('status.activityRunning');
  if (a === 'awaiting-approval') return t('status.activityAwaitingApproval');
  if (a === 'awaiting-question') return t('status.activityAwaitingQuestion');
  return '';
});

const isRunning = computed(() => (props.activity ?? 'idle') === 'running');
</script>

<template>
  <div ref="rootRef" class="statusline">
    <!-- Disconnected indicator — only shown when NOT connected, no always-on dot -->
    <span
      v-if="!isConnected"
      class="disconn-label"
      :title="connTitle"
    >{{ connTitle }}</span>

    <!-- LEFT — per-message mode controls, as icon + value pills (no verbose
         "label: value" text). Permission is colour-coded by mode. -->

    <!-- Permission selector — colored pill + popover with descriptions -->
    <span class="kv perm-kv" :class="['perm-' + status.permission, { open: openPopover === 'perm' }]">
      <span
        class="kv-btn"
        role="button"
        tabindex="0"
        :title="t('status.permissionTooltip')"
        @click.stop="toggle('perm')"
        @keydown.enter="toggle('perm')"
        @keydown.space.prevent="toggle('perm')"
      >
        <b class="perm-val">{{ permLabel }}</b>
      </span>

      <div v-if="openPopover === 'perm'" class="popover perm-popover" role="listbox">
        <button
          v-for="opt in PERM_MODES"
          :key="opt.mode"
          class="pop-row pop-row-desc"
          :class="{ 'is-current': opt.mode === status.permission }"
          role="option"
          :aria-selected="opt.mode === status.permission"
          @click.stop="choosePermission(opt.mode)"
        >
          <span class="pop-check">{{ opt.mode === status.permission ? '✓' : '' }}</span>
          <span class="pop-body">
            <span class="pop-name" :style="{ color: opt.color }">{{ permLabelFor(opt.mode) }}</span>
            <span class="pop-desc">{{ t(opt.descKey) }}</span>
          </span>
        </button>
      </div>
    </span>

    <!-- Thinking — on/off toggle (TUI parity; no effort-level menu) -->
    <span
      class="kv think-kv"
      :class="{ 'think-on': thinkingOn }"
      role="button"
      tabindex="0"
      :title="t('status.thinkingTooltip')"
      @click="toggleThinking"
      @keydown.enter="toggleThinking"
      @keydown.space.prevent="toggleThinking"
    >
      <span class="plan-lbl">{{ t('status.thinkingLabel') }}</span>
    </span>

    <!-- Plan mode — list icon toggle (blue when on) -->
    <span
      class="kv plan-kv"
      :class="{ 'plan-on': planOn }"
      role="button"
      tabindex="0"
      :title="t('status.planTooltip')"
      @click="emit('togglePlan')"
      @keydown.enter="emit('togglePlan')"
      @keydown.space.prevent="emit('togglePlan')"
    >
      <span class="plan-lbl">{{ t('status.planLabel') }}</span>
    </span>

    <!-- Activity indicator -->
    <span v-if="activityText" class="kv activity">
      <span class="act-text">{{ activityText }}</span>
      <button v-if="isRunning" class="interrupt-btn" @click.stop="emit('interrupt')">{{ t('status.interrupt') }}</button>
    </span>

    <!-- RIGHT — model (compact, with chevron) + context ring. -->
    <span
      class="kv model-kv"
      role="button"
      tabindex="0"
      :title="t('status.modelTooltip')"
      @click="emit('pickModel')"
      @keydown.enter="emit('pickModel')"
      @keydown.space.prevent="emit('pickModel')"
    >
      <b class="model-name">{{ status.model }}</b>
      <svg class="cv" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
    </span>

    <!-- Context meter — compact ring (filled by % used). -->
    <span class="kv ctx-kv" :title="ctxTooltip">
      <span class="ring" :style="{ background: `conic-gradient(var(--blue) ${pct * 3.6}deg, var(--line2) 0)` }"></span>
      <span class="ctx-num">{{ kFmt(status.ctxUsed) }}</span>
      <button v-if="showCompact" class="compact-chip" @click.stop="emit('compact')">/compact</button>
    </span>
  </div>
</template>

<style scoped>
.statusline {
  display: flex;
  align-items: center;
  border-top: 1px solid var(--line);
  background: var(--panel);
  font-size: 14px;
  color: var(--dim);
  /* Align the left edge with the composer's input box (16px gutter). */
  padding: 0 14px;
  height: 28px;
  overflow: visible;
  white-space: nowrap;
  position: relative;
}

/* Disconnected label — only visible when not connected */
.disconn-label {
  font-size: 9.5px;
  padding: 0 8px;
  color: var(--faint);
  flex: none;
  cursor: default;
}

.kv {
  padding: 0 9px;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  /* Footer look: no cell dividers, just spacing (the bars sit under the input). */
  border-right: none;
  flex: none;
  position: relative;
}
.kv.kv-first,
.kv:first-child {
  padding-left: 4px;
}
/* Context meter pushed to the far right. */
/* right-hand group (model + ctx) is pushed right via .model-kv below */
.kv b {
  color: var(--ink);
  font-weight: 500;
}
.kvl { color: var(--muted); font-weight: 400; }

.kv-icon {
  flex: none;
  color: var(--dim);
}

/* Clickable inner button for pills with popovers */
.kv-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  cursor: pointer;
  user-select: none;
}

.bar {
  width: 60px;
  height: 5px;
  border-radius: 2px;
  background: #d7dbe1;
  overflow: hidden;
  flex: none;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--blue);
  transition: width 0.3s;
}

/* /compact chip */
.compact-chip {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--warn);
  font-family: var(--mono);
  font-size: 9.5px;
  padding: 0 5px;
  cursor: pointer;
  height: 16px;
  line-height: 14px;
  flex: none;
}
.compact-chip:hover { background: var(--panel2); }

/* Interactive status controls are functional pill-buttons that serve the input
   box right above them: inset (shorter than the bar), rounded, soft-blue on
   hover/open. The ctx meter stays a plain indicator (not a button). */
.model-kv,
.think-kv,
.plan-kv,
.perm-kv {
  height: 22px;
  align-self: center;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s ease, color 0.12s ease;
}
/* icon inside a control pill — inherits the pill's text colour */
.kv .ic { flex: none; }

/* model + ctx are the right-hand group; model starts it. */
.model-kv { margin-left: auto; gap: 4px; }
.model-name {
  display: inline-block;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.kv .cv { color: var(--faint); flex: none; }
.model-kv:hover { background: var(--soft); color: var(--blue2); }
.kv:hover .cv,
.kv.open .cv { color: var(--blue2); }

/* thinking + plan: soft-blue on hover/open */
.think-kv:hover,
.think-kv.open,
.plan-kv:hover {
  background: var(--soft);
  color: var(--blue2);
}
.plan-kv { color: var(--muted); }
.plan-lbl { font-weight: 500; }
.plan-kv.plan-on { background: var(--soft); color: var(--blue); }
.think-kv { color: var(--muted); }
.think-kv.think-on { background: var(--soft); color: var(--blue); }

/* permission: colour-coded pill by mode (manual ghost / auto amber / yolo red) */
.perm-val { font-weight: 500; }
.perm-manual { color: var(--dim); }
.perm-manual:hover,
.perm-manual.open { background: var(--soft); color: var(--blue2); }
.perm-auto { background: #fbf1dd; color: var(--warn); }
.perm-auto:hover,
.perm-auto.open { background: #f6e8c8; }
.perm-yolo { background: #fcebea; color: var(--err); }
.perm-yolo:hover,
.perm-yolo.open { background: #f8dcda; }

/* context ring — conic fill by % used, white centre makes it a ring */
.ctx-kv { gap: 6px; cursor: default; }
.ring {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  flex: none;
  position: relative;
}
.ring::after {
  content: "";
  position: absolute;
  inset: 3.5px;
  border-radius: 50%;
  background: var(--bg);
}
.ctx-num { color: var(--muted); font-family: var(--mono); font-size: 11px; }

/* Popover (shared look for thinking + permission) */
.popover {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  z-index: 60;
  min-width: 130px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.16);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.perm-popover { min-width: 240px; }

.pop-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  padding: 5px 7px;
  border-radius: 3px;
  text-align: left;
}
.pop-row:hover { background: var(--soft); }
.pop-row.is-current { color: var(--ink); }
.pop-row-desc { align-items: flex-start; }

.pop-check {
  width: 12px;
  flex: none;
  color: var(--blue);
  font-weight: 700;
  display: flex;
  justify-content: center;
}
.pop-name { font-weight: 600; }
.pop-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.pop-desc {
  color: var(--muted);
  font-size: 10px;
  white-space: normal;
  line-height: 1.35;
}

/* Activity */
.activity {
  margin-left: auto;
  border-right: none;
  border-left: none;
  gap: 8px;
}
.act-text { color: var(--warn); font-size: 10.5px; }

/* Interrupt button */
.interrupt-btn {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--err);
  font-family: var(--mono);
  font-size: 10px;
  padding: 0 6px;
  cursor: pointer;
  height: 18px;
  line-height: 16px;
}
.interrupt-btn:hover { background: var(--panel2); }
</style>
