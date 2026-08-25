<!-- apps/desktop/src/renderer/components/PrPreviewIndicator.vue -->
<!-- PR preview entry (desktop-only, dev builds / Kimi Code Canary): a pill in
     the sidebar header that opens a Dialog to build a code-app pull request's
     (or any branch/tag/sha's) renderer in an isolated git worktree
     (main/pr-preview.ts) and load it into this window.
     States: idle (pick a PR/branch, or enter a custom ref) →
     fetching/installing/building (live phase + cancel) → active (the window
     is serving the preview build; exit or fetch & rebuild) → error (stage
     output tail + retry). Hidden unless the preload bridge exposes the
     pr-preview methods AND getState answers non-null (stable packaged builds
     answer null) — plain web never renders this.
     Desktop-only file, not synced to web (docs/native-todos.md). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Field, Icon, Input, Menu, MenuItem, Spinner } from '@moonshot-ai/app-ui';
import type { IconName } from '@moonshot-ai/app-client/icons';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import {
  canUsePrPreview,
  cancelPrPreview,
  cleanupPrPreviews,
  getPrPreviewState,
  listPrPreviewRefs,
  onPrPreviewEvent,
  startPrPreview,
  stopPrPreview,
  type PrPreviewRefList,
  type PrPreviewState,
  type PrPreviewTarget,
} from '../lib/prPreview';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

/** The sidebar pill renders by default; DebugMenu mounts the component
 *  pill-less and drives the dialog through the exposed open(). */
const { pill = true } = defineProps<{ pill?: boolean }>();

const available = ref(false);
const state = ref<PrPreviewState>({ phase: 'idle' });
const open = ref(false);
/** Combobox query: free-form text (PR number / branch / tag / sha) that also
 *  filters the suggestion list; picking a suggestion fills it and records
 *  the canonical target. */
const query = ref('');
const listOpen = ref(false);
const activeIndex = ref(-1);
const chosenTarget = ref<PrPreviewTarget | null>(null);
const refList = ref<PrPreviewRefList>({ prs: [], branches: [] });

// Suggestion-menu anchoring (the menu teleports to <body> — see template):
// track the input's viewport rect, refreshed on open and on window resize.
const comboAnchor = ref<HTMLElement | null>(null);
const anchorRect = ref<DOMRect | null>(null);
function refreshAnchor(): void {
  anchorRect.value = comboAnchor.value?.getBoundingClientRect() ?? null;
}
watch(listOpen, (isOpen) => {
  if (isOpen) refreshAnchor();
});
const comboMenuStyle = computed(() => {
  const rect = anchorRect.value;
  if (rect === null) return {};
  return {
    position: 'fixed' as const,
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    zIndex: 'var(--z-modal-dropdown)',
  };
});
/** Local (renderer-side) failures: invalid input, or the invoke itself threw. */
const localError = ref('');
/** Neutral outcome line (cleanup result). */
const localInfo = ref('');

let off: (() => void) | null = null;
onMounted(async () => {
  if (!canUsePrPreview()) return;
  let initial: PrPreviewState | null = null;
  try {
    initial = await getPrPreviewState();
  } catch {
    initial = null;
  }
  if (initial === null) return; // stable packaged build — the feature stays hidden
  available.value = true;
  state.value = initial;
  off = onPrPreviewEvent((next) => {
    state.value = next;
  });
  // The picker list is independent of the preview state and best-effort —
  // empty halves just mean the picker offers fewer suggestions.
  refList.value = await listPrPreviewRefs().catch(() => ({ prs: [], branches: [] }));
});
onUnmounted(() => {
  off?.();
});

// Reposition the teleported suggestion menu with the window.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', refreshAnchor);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
}
onUnmounted(() => {
  window.removeEventListener('resize', refreshAnchor);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

const busy = computed(
  () =>
    state.value.phase === 'fetching' ||
    state.value.phase === 'installing' ||
    state.value.phase === 'building',
);

// Elapsed-time ticker for the busy view: even a quiet stage (pnpm resolving,
// vite transforming) reads as "alive" when the clock keeps moving.
const busySince = ref<number | null>(null);
const elapsedSec = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
watch(busy, (isBusy) => {
  if (isBusy) {
    if (tickTimer !== null) return;
    busySince.value = Date.now();
    elapsedSec.value = 0;
    tickTimer = setInterval(() => {
      if (busySince.value !== null) {
        elapsedSec.value = Math.floor((Date.now() - busySince.value) / 1000);
      }
    }, 1000);
  } else {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    busySince.value = null;
    elapsedSec.value = 0;
  }
});
onUnmounted(() => {
  if (tickTimer !== null) clearInterval(tickTimer);
});

const elapsedText = computed(() => {
  const minutes = Math.floor(elapsedSec.value / 60);
  const seconds = elapsedSec.value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});

// Live stage output (main streams the throttled tail over the state channel);
// the log box pins itself to the bottom as lines arrive.
const logEl = ref<HTMLElement | null>(null);
watch(
  () => state.value.logTail,
  async () => {
    await nextTick();
    const el = logEl.value;
    if (el !== null) el.scrollTop = el.scrollHeight;
  },
);

const phaseText = computed(() => {
  switch (state.value.phase) {
    case 'fetching':
      return t('prPreview.fetching', { pr: state.value.label ?? state.value.pr ?? '' });
    case 'installing':
      return t('prPreview.installing');
    case 'building':
      return t('prPreview.building');
    default:
      return '';
  }
});

const pillText = computed(() => {
  if (state.value.phase === 'active') {
    const label = state.value.label ?? (state.value.pr !== undefined ? `#${state.value.pr}` : '');
    if (label !== '') return label;
  }
  if (busy.value) return phaseText.value;
  if (state.value.phase === 'error') return t('prPreview.errorTitle');
  return t('prPreview.title');
});

const pillIcon = computed<IconName>(() =>
  state.value.phase === 'error' ? 'alert-triangle' : 'git-pull-request',
);

const STAGE_NAME_KEYS = {
  fetch: 'prPreview.stageFetch',
  install: 'prPreview.stageInstall',
  build: 'prPreview.stageBuild',
} as const;

/** Localized stage failure/hang line for the error dialog; the raw command
 *  and output tail stay in the log <pre> below it (data, not prose). */
const errorStageText = computed(() => {
  const stage = state.value.errorStage;
  if (stage === undefined) return '';
  const stageName = t(STAGE_NAME_KEYS[stage]);
  return state.value.errorHung === true
    ? t('prPreview.stageHung', { stage: stageName })
    : t('prPreview.stageFailed', { stage: stageName });
});

// Reentrancy guard: rapid double-clicks must not fire a second invoke — the
// main process rejects it with an English 'already in flight', which would
// otherwise land in the dialog as localError while the first build runs.
let startInFlight = false;
async function runStart(target: PrPreviewTarget): Promise<void> {
  if (startInFlight) return;
  startInFlight = true;
  localError.value = '';
  try {
    // Spread into a plain object: a picked target lives in a ref and is
    // therefore a Vue reactive proxy, which Electron's IPC structured clone
    // rejects ("An object could not be cloned").
    state.value = await startPrPreview({ ...target });
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  } finally {
    startInFlight = false;
  }
}

interface RefOption {
  key: string;
  /** Display text (also what a pick writes back into the query). */
  label: string;
  target: PrPreviewTarget;
}

/** Suggestion candidates: open PRs first, then remote branches. */
const candidates = computed<RefOption[]>(() => [
  ...refList.value.prs.map((pr) => ({
    key: `pr:${pr.number}`,
    label: `#${pr.number} · ${pr.title}`,
    target: { kind: 'pr', pr: pr.number } as PrPreviewTarget,
  })),
  ...refList.value.branches.map((branch) => ({
    key: `ref:${branch}`,
    label: branch,
    target: { kind: 'ref', ref: branch } as PrPreviewTarget,
  })),
]);

const MAX_SUGGESTIONS = 8;

/** Substring-filtered suggestions (case-insensitive, matches PR title/number
 *  and branch names); an empty query shows the head of the full list. */
const filtered = computed<RefOption[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (q === '') return candidates.value.slice(0, MAX_SUGGESTIONS);
  return candidates.value.filter((option) => option.label.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
});

const CUSTOM_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

/** Parse free-form input: all digits = PR number, otherwise a git ref. */
function parseQuery(raw: string): PrPreviewTarget | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pr = Number(text);
    return pr >= 1 && pr <= 999999 ? { kind: 'pr', pr } : null;
  }
  if (text.startsWith('#')) {
    const pr = Number(text.slice(1));
    return Number.isInteger(pr) && pr >= 1 && pr <= 999999 ? { kind: 'pr', pr } : null;
  }
  if (CUSTOM_REF_RE.test(text) && !text.includes('..')) {
    return { kind: 'ref', ref: text };
  }
  return null;
}

function pick(option: RefOption): void {
  chosenTarget.value = option.target;
  query.value = option.label;
  listOpen.value = false;
  activeIndex.value = -1;
}

function onQueryInput(): void {
  // Typing after a pick invalidates it — the start button re-parses.
  chosenTarget.value = null;
  localError.value = '';
  listOpen.value = true;
  activeIndex.value = -1;
}

// Open/close follows pointer semantics, not focus events: the dialog
// auto-focuses the input on open (an already-focused element fires no focus
// event), so @focus could never reopen the menu. The menu opens on pointer
// down anywhere in the combo (and on typing) and closes on an outside
// pointerdown (document capture — the menu teleports to <body>, so both
// containers are checked).
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (target === null) return;
  if (target.closest('.prp-combo') !== null || target.closest('.prp-combo-menu') !== null) return;
  listOpen.value = false;
}

function onQueryKeydown(event: KeyboardEvent): void {
  const items = filtered.value;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (items.length === 0) return;
    event.preventDefault();
    listOpen.value = true;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + items.length) % items.length;
    return;
  }
  if (event.key === 'Enter') {
    if (listOpen.value && activeIndex.value >= 0 && activeIndex.value < items.length) {
      event.preventDefault();
      event.stopPropagation();
      pick(items[activeIndex.value]!);
      return;
    }
    // No active suggestion: Enter means start (handled by the input's own
    // keydown.enter binding below).
    return;
  }
  if (event.key === 'Escape') {
    if (listOpen.value) {
      event.stopPropagation();
      listOpen.value = false;
    }
  }
}

function onStart(): void {
  const target = chosenTarget.value ?? parseQuery(query.value);
  if (target === null) {
    localError.value = t('prPreview.invalidRef');
    return;
  }
  void runStart(target);
}

/** The retry/rebuild target mirrors the last operation: PRs carry `pr`, refs
 *  carry `refTarget`. */
const lastTarget = computed<PrPreviewTarget | null>(() => {
  if (state.value.pr !== undefined) return { kind: 'pr', pr: state.value.pr };
  if (state.value.refTarget !== undefined && state.value.refTarget !== '') {
    return { kind: 'ref', ref: state.value.refTarget };
  }
  return null;
});

function onRebuild(): void {
  if (lastTarget.value !== null) void runStart(lastTarget.value);
}

async function onStop(): Promise<void> {
  try {
    state.value = await stopPrPreview();
  } catch {
    // The stop invoke only fails on a broken bridge; the next event push (or
    // remount) resyncs the state.
  }
}

async function onCancel(): Promise<void> {
  try {
    state.value = await cancelPrPreview();
  } catch {
    // Same resync story as onStop.
  }
}

/** Manual cache reclaim: everything except the served/in-flight worktree goes
 *  (other live instances' dirs are skipped main-side). Confirm first — the
 *  next preview of a cleaned PR is a full rebuild. */
async function onCleanup(): Promise<void> {
  localInfo.value = '';
  const ok = await confirm({
    title: t('prPreview.cleanup'),
    message: t('prPreview.cleanupConfirm'),
    confirmLabel: t('prPreview.cleanup'),
    variant: 'primary',
  });
  if (!ok) return;
  try {
    const removed = await cleanupPrPreviews();
    localInfo.value = t('prPreview.cleanupDone', { count: removed });
  } catch {
    // A broken bridge resyncs on the next event; nothing to surface here.
  }
}

// DebugMenu mounts this pill-less and drives the dialog / reads the state.
defineExpose({
  open: () => {
    open.value = true;
  },
  state,
});
</script>

<template>
  <span v-if="available" class="prp" :data-state="state.phase">
    <button v-if="pill" class="prp-pill" type="button" :aria-label="pillText" @click="open = true">
      <Spinner v-if="busy" size="xs" />
      <Icon v-else class="prp-pill-icon" :name="pillIcon" size="sm" />
      <span class="prp-pill-text">{{ pillText }}</span>
    </button>

    <Dialog :open="open" :title="t('prPreview.title')" size="md" @update:open="open = $event">
      <p class="prp-intro">{{ t('prPreview.intro') }}</p>

      <Field v-if="state.phase === 'idle'" :label="t('prPreview.prLabel')">
        <div ref="comboAnchor" class="prp-combo" @pointerdown="listOpen = true">
          <Input
            v-model="query"
            :placeholder="t('prPreview.customRefPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @input="onQueryInput"
            @keydown="onQueryKeydown"
            @keydown.enter.stop="onStart"
          />
          <!-- The dialog body clips overflow — the suggestion menu escapes to
               <body> and anchors fixed to the input (UserMenu 同款出逃模式). -->
          <Teleport to="body">
            <Menu v-if="listOpen && filtered.length > 0" class="prp-combo-menu" role="menu" :style="comboMenuStyle">
              <MenuItem
                v-for="(option, index) in filtered"
                :key="option.key"
                :active="index === activeIndex"
                @mousedown.prevent="pick(option)"
              >
                <span class="prp-combo-label">{{ option.label }}</span>
              </MenuItem>
            </Menu>
          </Teleport>
        </div>
      </Field>

      <div v-else-if="busy" class="prp-busy">
        <Spinner size="md" />
        <span class="prp-busy-text">{{ phaseText }}</span>
        <span class="prp-busy-time">{{ elapsedText }}</span>
      </div>
      <pre v-if="busy && state.logTail" ref="logEl" class="prp-log">{{ state.logTail }}</pre>

      <p v-else-if="state.phase === 'active'" class="prp-active">
        {{ t('prPreview.activeText', { pr: state.label ?? state.pr ?? '' }) }}
      </p>

      <template v-else-if="state.phase === 'error'">
        <p class="prp-error-title">{{ errorStageText !== '' ? errorStageText : t('prPreview.errorTitle') }}</p>
        <!-- Raw stage messages are log tails (data) and render verbatim. -->
        <pre v-if="state.message" class="prp-error-log">{{ state.message }}</pre>
      </template>

      <p v-if="localError" class="prp-local-error">{{ localError }}</p>
      <p v-if="localInfo" class="prp-local-info">{{ localInfo }}</p>

      <template #foot>
        <div class="prp-foot">
          <template v-if="state.phase === 'idle'">
            <Button variant="ghost" class="prp-foot-left" @click="onCleanup">{{ t('prPreview.cleanup') }}</Button>
            <Button variant="ghost" @click="open = false">{{ t('common.close') }}</Button>
            <Button :disabled="query.trim() === ''" @click="onStart">
              {{ t('prPreview.start') }}
            </Button>
          </template>
          <template v-else-if="busy">
            <Button variant="secondary" @click="onCancel">{{ t('common.cancel') }}</Button>
          </template>
          <template v-else-if="state.phase === 'active'">
            <Button variant="ghost" class="prp-foot-left" @click="onCleanup">{{ t('prPreview.cleanup') }}</Button>
            <Button variant="ghost" @click="open = false">{{ t('common.close') }}</Button>
            <Button variant="secondary" @click="onRebuild">{{ t('prPreview.rebuild') }}</Button>
            <Button @click="onStop">{{ t('prPreview.stop') }}</Button>
          </template>
          <template v-else-if="state.phase === 'error'">
            <Button variant="ghost" @click="open = false">{{ t('common.close') }}</Button>
            <!-- A failed rebuild keeps the previous preview serving — offer
                 the exit alongside retry, same as the native menu does. -->
            <Button v-if="state.servingPr !== undefined || state.servingLabel !== undefined" variant="secondary" @click="onStop">
              {{ t('prPreview.stop') }}
            </Button>
            <Button @click="onRebuild">{{ t('prPreview.retry') }}</Button>
          </template>
        </div>
      </template>
    </Dialog>
  </span>
</template>

<style scoped>
.prp {
  display: inline-flex;
  flex: none;
  /* The parent chrome may be a window-drag strip — the pill must stay clickable. */
  -webkit-app-region: no-drag;
  animation: prp-in var(--duration-base) var(--ease-out);
}
@keyframes prp-in {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
}

.prp-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  white-space: nowrap;
  cursor: pointer;
  transition: filter var(--duration-fast) var(--ease-out);
}
.prp-pill:hover {
  filter: brightness(1.1);
}
.prp-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.prp-pill-icon {
  flex: none;
  color: var(--color-text-on-accent);
}
/* Active = the window is serving the preview build: warning yellow, matching
   the update pill's "action pending" signal; error flips to danger. */
.prp[data-state='active'] .prp-pill {
  background: var(--color-warning);
}
.prp[data-state='error'] .prp-pill {
  background: var(--color-danger);
}

/* Narrow header = icons only (matches the update pill's degradation — see
   the `@container sidebar-col` rules in Sidebar.vue). */
@container sidebar-col (max-width: 250px) {
  .prp-pill {
    padding: var(--space-1);
  }
  .prp-pill-text {
    display: none;
  }
}

.prp-intro {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-faint);
}
.prp-intro + * {
  margin-top: var(--space-3);
}

/* Combobox (query input + suggestion menu): the menu teleports to <body> and
   anchors fixed to the input (inline comboMenuStyle), scrolling internally
   when the suggestion cap is hit. */
.prp-combo {
  position: relative;
}
.prp-combo-menu {
  max-height: min(320px, 50vh);
  overflow-y: auto;
}
.prp-combo-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prp-busy {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.prp-busy-time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}

/* Live stage output under the busy row: a capped, auto-scrolling mini log. */
.prp-log {
  margin: var(--space-3) 0 0;
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  max-height: min(240px, 40vh);
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-all;
}

.prp-active {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text);
}

.prp-error-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  color: var(--color-danger);
}
.prp-error-log {
  margin: var(--space-2) 0 0;
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  max-height: min(240px, 40vh);
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-all;
}

.prp-local-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-danger);
}
.prp-local-info {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-faint);
}

.prp-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
.prp-foot-left {
  margin-right: auto;
}
</style>
