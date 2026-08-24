<!-- apps/desktop/src/renderer/components/PrPreviewIndicator.vue -->
<!-- PR preview entry (desktop-only, dev builds): a pill in the sidebar header
     that opens a Dialog to build a code-app pull request's renderer in an
     isolated git worktree (main/pr-preview.ts) and load it into this window.
     States: idle (enter a PR number) → fetching/installing/building (live
     phase + cancel) → active (the window is serving the preview build; exit
     or fetch & rebuild) → error (stage output tail + retry). Hidden unless
     the preload bridge exposes the pr-preview methods AND getState answers
     non-null (packaged builds answer null) — plain web never renders this.
     Desktop-only file, not synced to web (docs/native-todos.md). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Field, Icon, Input, Spinner } from '@moonshot-ai/app-ui';
import type { IconName } from '@moonshot-ai/app-client/icons';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import {
  canUsePrPreview,
  cancelPrPreview,
  cleanupPrPreviews,
  getPrPreviewState,
  onPrPreviewEvent,
  startPrPreview,
  stopPrPreview,
  type PrPreviewState,
} from '../lib/prPreview';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

const available = ref(false);
const state = ref<PrPreviewState>({ phase: 'idle' });
const open = ref(false);
const prInput = ref('');
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
  if (initial === null) return; // packaged build — the feature stays hidden
  available.value = true;
  state.value = initial;
  off = onPrPreviewEvent((next) => {
    state.value = next;
  });
});
onUnmounted(() => {
  off?.();
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
      return t('prPreview.fetching', { pr: state.value.pr ?? '' });
    case 'installing':
      return t('prPreview.installing');
    case 'building':
      return t('prPreview.building');
    default:
      return '';
  }
});

const pillText = computed(() => {
  if (state.value.phase === 'active' && state.value.pr !== undefined) {
    return `PR #${state.value.pr}`;
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
async function runStart(pr: number): Promise<void> {
  if (startInFlight) return;
  startInFlight = true;
  localError.value = '';
  try {
    state.value = await startPrPreview(pr);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  } finally {
    startInFlight = false;
  }
}

function onStart(): void {
  const pr = Number(prInput.value.trim());
  // The upper bound mirrors the main-process validator — keeping it here
  // routes oversize input to the localized invalidPr instead of an English
  // IPC error.
  if (!Number.isInteger(pr) || pr < 1 || pr > 999999) {
    localError.value = t('prPreview.invalidPr');
    return;
  }
  void runStart(pr);
}

function onRebuild(): void {
  if (state.value.pr !== undefined) void runStart(state.value.pr);
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
</script>

<template>
  <span v-if="available" class="prp" :data-state="state.phase">
    <button class="prp-pill" type="button" :aria-label="pillText" @click="open = true">
      <Spinner v-if="busy" size="xs" />
      <Icon v-else class="prp-pill-icon" :name="pillIcon" size="sm" />
      <span class="prp-pill-text">{{ pillText }}</span>
    </button>

    <Dialog :open="open" :title="t('prPreview.title')" size="md" @update:open="open = $event">
      <p class="prp-intro">{{ t('prPreview.intro') }}</p>

      <Field v-if="state.phase === 'idle'" :label="t('prPreview.prLabel')">
        <Input
          v-model="prInput"
          :placeholder="t('prPreview.prPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          inputmode="numeric"
          @keydown.enter.stop="onStart"
        />
      </Field>

      <div v-else-if="busy" class="prp-busy">
        <Spinner size="md" />
        <span class="prp-busy-text">{{ phaseText }}</span>
        <span class="prp-busy-time">{{ elapsedText }}</span>
      </div>
      <pre v-if="busy && state.logTail" ref="logEl" class="prp-log">{{ state.logTail }}</pre>

      <p v-else-if="state.phase === 'active' && state.pr !== undefined" class="prp-active">
        {{ t('prPreview.activeText', { pr: state.pr }) }}
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
            <Button :disabled="prInput.trim() === ''" @click="onStart">{{ t('prPreview.start') }}</Button>
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
            <Button v-if="state.servingPr !== undefined" variant="secondary" @click="onStop">
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
