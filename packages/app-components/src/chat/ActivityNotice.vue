<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SessionContextGroup } from '@moonshot-ai/app-core/api';
import { formatDuration, formatTokens } from '@moonshot-ai/app-core/lib';
import WorkingIndicator from './WorkingIndicator.vue';

type CellKind = 'base' | 'user' | 'other';
type CellVisualState = 'idle' | 'processing' | 'absorbed' | 'preserved' | 'stitched';
type SummaryVisualState = 'hidden' | 'condensing' | 'stitched';
type TailVisualState = 'hidden' | 'appended';

interface SlotDescriptor {
  readonly index: number;
  readonly kind: CellKind;
  readonly role: string;
  readonly ord: number;
  readonly initialX: number;
}

interface AnimatedCell {
  readonly index: number;
  readonly kind: CellKind;
  readonly role: string;
  readonly state: CellVisualState;
  readonly x: number;
}

const CELL_COUNT = 14;
const SLOT_STRIDE = 11;
const BASE_COUNT = 2;
const GROUP_GAP = 3;
const SUMMARY_CONDENSE_X = 34;
const SUMMARY_WIDTH = 18;
const CELL_WIDTH = 9;
const TOTAL_STEPS = 24;
const STEP_MS = 140;

const DEFAULT_OTHER_ROLES = [
  'assistant',
  'tool',
  'tool',
  'assistant',
  'tool',
  'assistant',
  'tool',
  'skill',
  'tool',
  'assistant',
] as const;

const props = defineProps<{
  label?: string;
  tokens?: number;
  groups?: readonly SessionContextGroup[];
}>();

const { t } = useI18n();

const startedAt = Date.now();
const elapsedMs = ref(0);
const animStep = ref(0);
const reducedMotion = ref(false);
const pageHidden = ref(false);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let animTimer: ReturnType<typeof setInterval> | null = null;
let motionQuery: MediaQueryList | null = null;

function stopTimers(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (animTimer !== null) {
    clearInterval(animTimer);
    animTimer = null;
  }
}

function syncTimers(): void {
  if (pageHidden.value) {
    stopTimers();
    return;
  }
  if (elapsedTimer === null) {
    elapsedMs.value = Math.max(0, Date.now() - startedAt);
    elapsedTimer = setInterval(() => {
      elapsedMs.value = Math.max(0, Date.now() - startedAt);
    }, 1000);
  }
  if (reducedMotion.value) {
    if (animTimer !== null) {
      clearInterval(animTimer);
      animTimer = null;
    }
  } else if (animTimer === null) {
    animTimer = setInterval(() => {
      animStep.value = (animStep.value + 1) % TOTAL_STEPS;
    }, STEP_MS);
  }
}

function syncReducedMotion(): void {
  reducedMotion.value = motionQuery?.matches === true;
}

function syncVisibility(): void {
  pageHidden.value = typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

watch([reducedMotion, pageHidden], syncTimers);

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    syncReducedMotion();
    motionQuery.addEventListener?.('change', syncReducedMotion);
  }
  if (typeof document !== 'undefined') {
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
  }
  syncTimers();
});

onUnmounted(() => {
  motionQuery?.removeEventListener?.('change', syncReducedMotion);
  motionQuery = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', syncVisibility);
  }
  stopTimers();
});

const metaLabel = computed(() => {
  const parts: string[] = [];
  if (props.tokens !== undefined && props.tokens > 0) {
    parts.push(formatTokens(props.tokens));
  }
  if (elapsedMs.value >= 1000) {
    parts.push(
      formatDuration(elapsedMs.value, {
        h: t('status.timeUnitHour'),
        m: t('status.timeUnitMinute'),
        s: t('status.timeUnitSecond'),
      }),
    );
  }
  return parts.join(' · ');
});

function allocateRoles(
  groups: readonly SessionContextGroup[],
  slotCount: number,
): string[] {
  if (slotCount <= 0) return [];
  const positive = groups.filter((group) => group.tokens > 0).slice(0, slotCount);
  const total = positive.reduce((sum, group) => sum + group.tokens, 0);
  if (positive.length === 0 || total <= 0) {
    return Array.from({ length: slotCount }, (_, idx) => DEFAULT_OTHER_ROLES[idx % DEFAULT_OTHER_ROLES.length]!);
  }
  const counts = positive.map(() => 1);
  const extra = slotCount - positive.length;
  const quotas = positive.map((group) => (group.tokens / total) * extra);
  const floors = quotas.map((quota) => Math.floor(quota));
  let leftover = extra - floors.reduce((sum, count) => sum + count, 0);
  const order = quotas
    .map((quota, idx) => ({ idx, rem: quota - floors[idx]! }))
    .toSorted((a, b) => b.rem - a.rem);
  for (let i = 0; i < order.length && leftover > 0; i += 1) {
    counts[order[i]!.idx]! += 1;
    leftover -= 1;
  }
  for (let i = 0; i < floors.length; i += 1) {
    counts[i]! += floors[i]!;
  }
  const interleaved: string[] = [];
  const remaining = [...counts];
  while (interleaved.length < slotCount) {
    let progressed = false;
    for (let i = 0; i < positive.length && interleaved.length < slotCount; i += 1) {
      if (remaining[i]! > 0) {
        interleaved.push(positive[i]!.role);
        remaining[i]! -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return interleaved;
}

const layoutPlan = computed(() => {
  const nonEmpty = (props.groups ?? []).filter((group) => group.tokens > 0);
  const hasSystem = nonEmpty.some((group) => group.role === 'system');
  const hasDefinition = nonEmpty.some((group) => group.role === 'definition');
  const baseRoles: [string, string] = nonEmpty.length === 0
    ? ['system', 'definition']
    : [
        hasSystem ? 'system' : (nonEmpty[0]?.role ?? 'system'),
        hasDefinition ? 'definition' : (hasSystem ? 'system' : (nonEmpty[0]?.role ?? 'definition')),
      ];

  const userGroup = nonEmpty.find((group) => group.role === 'user');
  const userSlotIndices = userGroup?.count === 1 ? [2, 10] : [2, 6, 10];
  const userOrderMap = new Map<number, number>();
  userSlotIndices.forEach((slotIdx, ord) => userOrderMap.set(slotIdx, ord));

  const otherSlotIndices: number[] = [];
  for (let idx = BASE_COUNT; idx < CELL_COUNT; idx += 1) {
    if (!userOrderMap.has(idx)) {
      otherSlotIndices.push(idx);
    }
  }

  const otherGroups = nonEmpty.filter(
    (group) => group.role !== 'system' && group.role !== 'definition' && group.role !== 'user',
  );
  const otherRoles = allocateRoles(otherGroups, otherSlotIndices.length);

  const slots: SlotDescriptor[] = [];
  let nextOtherOrd = 0;
  for (let idx = 0; idx < CELL_COUNT; idx += 1) {
    const initialX = idx * SLOT_STRIDE;
    if (idx < BASE_COUNT) {
      slots.push({ index: idx, kind: 'base', role: baseRoles[idx]!, ord: idx, initialX });
      continue;
    }
    const userOrd = userOrderMap.get(idx);
    if (userOrd !== undefined) {
      slots.push({ index: idx, kind: 'user', role: 'user', ord: userOrd, initialX });
      continue;
    }
    const ord = nextOtherOrd;
    nextOtherOrd += 1;
    slots.push({ index: idx, kind: 'other', role: otherRoles[ord] ?? 'tool', ord, initialX });
  }

  const userStartX = BASE_COUNT * SLOT_STRIDE + 1;
  const userEndX = userStartX + (userSlotIndices.length - 1) * SLOT_STRIDE + CELL_WIDTH;
  const summaryStitchedX = userEndX + GROUP_GAP;
  const tailStitchedX = summaryStitchedX + SUMMARY_WIDTH + GROUP_GAP;

  return {
    slots,
    otherSlotIndices,
    userStartX,
    summaryStitchedX,
    tailStitchedX,
  };
});

const effectiveStep = computed(() => {
  if (reducedMotion.value) return 15;
  return animStep.value;
});

const trackPhaseClass = computed(() => {
  if (reducedMotion.value) return 'is-steady';
  if (animStep.value === 21) return 'is-fading-out';
  if (animStep.value === 22) return 'is-snapping';
  return 'is-steady';
});

const cells = computed<AnimatedCell[]>(() => {
  const step = effectiveStep.value;
  const plan = layoutPlan.value;
  const totalOther = plan.otherSlotIndices.length;
  const condenseEnd = 2 + totalOther;
  const resetting = step >= 22;
  const stitching = !resetting && step >= condenseEnd;
  const sweep = step >= 2 && step < condenseEnd
    ? step - 2
    : stitching
      ? totalOther
      : -1;
  const activeOtherSlot = sweep >= 0 && sweep < totalOther
    ? plan.otherSlotIndices[sweep]!
    : stitching
      ? CELL_COUNT
      : -1;

  return plan.slots.map((slot): AnimatedCell => {
    if (slot.kind === 'base') {
      return {
        index: slot.index,
        kind: 'base',
        role: slot.role,
        state: 'idle',
        x: slot.initialX,
      };
    }
    if (slot.kind === 'user') {
      if (stitching) {
        return {
          index: slot.index,
          kind: 'user',
          role: 'user',
          state: 'stitched',
          x: plan.userStartX + slot.ord * SLOT_STRIDE,
        };
      }
      return {
        index: slot.index,
        kind: 'user',
        role: 'user',
        state: activeOtherSlot > slot.index ? 'preserved' : 'idle',
        x: slot.initialX,
      };
    }
    if (stitching || (sweep >= 0 && slot.ord < sweep)) {
      return {
        index: slot.index,
        kind: 'other',
        role: slot.role,
        state: 'absorbed',
        x: stitching ? plan.summaryStitchedX + 4 : SUMMARY_CONDENSE_X + 4,
      };
    }
    if (sweep === slot.ord) {
      return {
        index: slot.index,
        kind: 'other',
        role: slot.role,
        state: 'processing',
        x: slot.initialX,
      };
    }
    return {
      index: slot.index,
      kind: 'other',
      role: slot.role,
      state: 'idle',
      x: slot.initialX,
    };
  });
});

const summaryBlock = computed(() => {
  const step = effectiveStep.value;
  const plan = layoutPlan.value;
  const totalOther = plan.otherSlotIndices.length;
  const condenseEnd = 2 + totalOther;
  if (step < 3 || step >= 22) {
    return {
      state: 'hidden' as SummaryVisualState,
      x: SUMMARY_CONDENSE_X,
      scaleX: 0.5,
    };
  }
  if (step >= condenseEnd) {
    return {
      state: 'stitched' as SummaryVisualState,
      x: plan.summaryStitchedX,
      scaleX: 1,
    };
  }
  const absorbed = Math.min(totalOther, Math.max(1, step - 2));
  const scaleX = absorbed === 1
    ? 0.5
    : 0.6 + 0.4 * ((absorbed - 1) / Math.max(1, totalOther - 1));
  return {
    state: 'condensing' as SummaryVisualState,
    x: SUMMARY_CONDENSE_X,
    scaleX,
  };
});

const tailBlock = computed(() => {
  const step = effectiveStep.value;
  const plan = layoutPlan.value;
  const tailStep = 4 + plan.otherSlotIndices.length;
  if (step >= tailStep && step < 22) {
    return {
      state: 'appended' as TailVisualState,
      x: plan.tailStitchedX,
    };
  }
  return {
    state: 'hidden' as TailVisualState,
    x: plan.tailStitchedX + 8,
  };
});
</script>

<template>
  <component
    :is="label ? WorkingIndicator : 'span'"
    class="activity-notice"
    v-bind="label ? { label } : {}"
  >
    <span class="an-inline">
      <span class="an-track" :class="trackPhaseClass" aria-hidden="true">
        <span
          v-for="cell in cells"
          :key="cell.index"
          class="an-cell"
          :class="`is-${cell.state}`"
          :data-cell-kind="cell.kind"
          :data-context-role="cell.role"
          :style="{ transform: `translate3d(${cell.x}px, ${cell.state === 'processing' ? -1.5 : 0}px, 0) scale(${cell.state === 'absorbed' ? 0.5 : cell.state === 'processing' ? 1.08 : 1})` }"
        />
        <span
          class="an-summary"
          :class="`is-${summaryBlock.state}`"
          data-context-role="compaction"
          :style="{ transform: `translate3d(${summaryBlock.x}px, 0, 0) scaleX(${summaryBlock.scaleX})` }"
        />
        <span
          class="an-tail"
          :class="`is-${tailBlock.state}`"
          data-context-role="reminder"
          :style="{ transform: `translate3d(${tailBlock.x}px, 0, 0)` }"
        />
      </span>
      <span v-if="metaLabel" class="an-meta">{{ metaLabel }}</span>
    </span>
  </component>
</template>

<style scoped>
.activity-notice {
  display: inline-flex;
  align-items: center;
}

.an-inline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.an-track {
  position: relative;
  display: inline-block;
  width: 156px;
  height: 10px;
  border-radius: 3px;
  background: var(--color-fill-2);
  box-sizing: border-box;
  overflow: hidden;
  contain: layout paint style;
  transition: opacity 150ms var(--ease-out);
}

.an-track.is-fading-out,
.an-track.is-snapping {
  opacity: 0;
}

.an-cell,
.an-summary,
.an-tail {
  position: absolute;
  top: 2px;
  left: 2px;
  height: 6px;
  border-radius: 1.5px;
  background: var(--context-color, var(--color-accent));
}

.an-cell {
  width: 9px;
  z-index: 1;
  opacity: 0.84;
  transition:
    transform 230ms var(--ease-out),
    opacity 170ms var(--ease-out);
}

.an-cell[data-cell-kind="user"] {
  z-index: 3;
  opacity: 0.92;
}

.an-cell.is-processing {
  z-index: 4;
  opacity: 1;
}

.an-cell.is-preserved,
.an-cell.is-stitched {
  opacity: 1;
}

.an-cell.is-absorbed {
  opacity: 0;
  pointer-events: none;
}

.an-summary {
  width: 18px;
  z-index: 2;
  transform-origin: left center;
  border-radius: 2px;
  transition:
    transform 240ms var(--ease-out),
    opacity 160ms var(--ease-out);
}

.an-summary.is-hidden {
  opacity: 0;
}

.an-summary.is-condensing,
.an-summary.is-stitched {
  opacity: 1;
}

.an-tail {
  width: 9px;
  z-index: 2;
  transition:
    transform 210ms var(--ease-out),
    opacity 170ms var(--ease-out);
}

.an-tail.is-hidden {
  opacity: 0;
}

.an-tail.is-appended {
  opacity: 1;
}

.an-track.is-snapping .an-cell,
.an-track.is-snapping .an-summary,
.an-track.is-snapping .an-tail {
  transition: none;
}

.an-meta {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .an-track,
  .an-cell,
  .an-summary,
  .an-tail {
    transition: none;
  }
}
</style>
