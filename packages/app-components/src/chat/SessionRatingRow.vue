<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Tooltip } from '@moonshot-ai/app-ui';
import type { AppSessionRatingResponse, AppSessionRatingView } from '@moonshot-ai/app-core/api';

const ENTRANCE_GUARD_MS = 600;
const PICK_MS = 150;
const FLY_MS = 480;
const GHOST_FADE_MS = 320;
const LAND_CLASS_MS = 520;
const BURST_MS = 900;
const BLINK_AT_MS = 720;
const BLINK_CLASS_MS = 300;
const RESPONSES: readonly AppSessionRatingResponse[] = ['bad', 'fine', 'good'];
const EYES: Record<AppSessionRatingResponse, readonly [string, string]> = {
  bad: ['M7.5 9.9L10.5 11.7 7.5 13.5', 'M16.5 9.9L13.5 11.7 16.5 13.5'],
  fine: ['M9 9.9V13.5', 'M15 9.9V13.5'],
  good: ['M7.3 13.3C7.3 9.1 10.7 9.1 10.7 13.3', 'M13.3 13.3C13.3 9.1 16.7 9.1 16.7 13.3'],
};
const LABEL_KEYS: Record<AppSessionRatingResponse, string> = {
  bad: 'conversation.sessionRatingBad',
  fine: 'conversation.sessionRatingFine',
  good: 'conversation.sessionRatingGood',
};
const SPARKS = Array.from({ length: 10 }, (_, i) => ({
  angle: `${i * 36 + 18}deg`,
  distance: `${i % 2 ? -15 : -19}px`,
  dot: i % 2 === 1,
}));

const props = defineProps<{
  view: Exclude<AppSessionRatingView, { phase: 'closed' }>;
  standalone?: boolean;
}>();

const emit = defineEmits<{
  shown: [appearanceId: string];
  select: [response: AppSessionRatingResponse];
  undo: [];
}>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | undefined;
let shownObserver: IntersectionObserver | undefined;

type RatingStage = 'question' | 'picking' | 'result';
const stage = ref<RatingStage>(props.view.phase === 'open' ? 'question' : 'result');
const picked = ref<AppSessionRatingResponse | undefined>(undefined);
const flying = ref(false);
const landing = ref(false);
const blinking = ref(false);
const bursting = ref(false);
const entering = ref(true);
const laneIntro = ref(false);
const ghost = ref<{ text: string; left: number; top: number } | null>(null);
let answerTimers: Array<ReturnType<typeof setTimeout>> = [];
let answerAnimations: Animation[] = [];
let focusUndoAfterFlight = false;

const chosen = computed(() => (props.view.phase === 'open' ? undefined : props.view.response));

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function afterPaint(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(callback));
  } else {
    setTimeout(callback, 0);
  }
}

function track(timer: ReturnType<typeof setTimeout>): void {
  answerTimers.push(timer);
}

function clearAnswer(): void {
  for (const timer of answerTimers) clearTimeout(timer);
  answerTimers = [];
  for (const animation of answerAnimations) animation.cancel();
  answerAnimations = [];
}

onMounted(() => {
  const rootEl = root.value;
  if (typeof IntersectionObserver === 'function' && rootEl !== null) {
    shownObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      shownObserver?.disconnect();
      shownObserver = undefined;
      emit('shown', props.view.appearanceId);
    });
    shownObserver.observe(rootEl);
  } else {
    emit('shown', props.view.appearanceId);
  }
  armTimer = setTimeout(() => {
    armed.value = true;
  }, ENTRANCE_GUARD_MS);
  afterPaint(() => {
    entering.value = false;
  });
});

onBeforeUnmount(() => {
  shownObserver?.disconnect();
  if (armTimer !== undefined) clearTimeout(armTimer);
  clearAnswer();
});

watch(
  () => props.view,
  (view, previous) => {
    if (view.phase === 'open') {
      if (previous.phase !== 'open') resetToQuestion();
      return;
    }
    if (stage.value === 'question') beginAnswer(view.response);
  },
);

function beginAnswer(response: AppSessionRatingResponse): void {
  const rootEl = root.value;
  focusUndoAfterFlight = rootEl !== null && rootEl.contains(document.activeElement);
  const face = rootEl?.querySelector(`.sr-face[data-response="${response}"] .kimi-face`);
  const question = rootEl?.querySelector('.sr-question');
  if (!rootEl || !face || !question || reducedMotion()) {
    stage.value = 'result';
    if (focusUndoAfterFlight) {
      focusUndoAfterFlight = false;
      moveFocusToUndo();
    }
    return;
  }
  const from = face.getBoundingClientRect();
  const questionRect = question.getBoundingClientRect();
  const questionText = question.textContent ?? '';
  picked.value = response;
  stage.value = 'picking';
  track(
    setTimeout(() => {
      fly(from, questionRect, questionText);
    }, PICK_MS),
  );
}

function fly(from: DOMRect, questionRect: DOMRect, questionText: string): void {
  const rootEl = root.value;
  if (!rootEl) return;
  const rowRect = rootEl.getBoundingClientRect();
  stage.value = 'result';
  flying.value = true;
  laneIntro.value = true;
  ghost.value = {
    text: questionText,
    left: questionRect.left - rowRect.left - rootEl.clientLeft,
    top: questionRect.top - rowRect.top - rootEl.clientTop,
  };
  void nextTick(() => {
    if (!flying.value || !root.value) return;
    const glyph = root.value.querySelector('.sr-chosen .kimi-face');
    if (glyph instanceof SVGElement) {
      const to = glyph.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const offsets = [0, 0.46, 0.84, 1];
      const xs = [dx, dx * 0.45, -1.5, 0];
      const ys = [dy, dy - 10, 0, 0];
      const tilt = [0, -8, 2, 0];
      if (typeof glyph.animate === 'function') {
        answerAnimations.push(
          glyph.animate(
            offsets.map((offset, i) => ({
              transform: `translate(${xs[i]}px, ${ys[i]}px) rotate(${tilt[i]}deg)`,
              offset,
            })),
            { duration: FLY_MS, easing: 'cubic-bezier(.3, .7, .3, 1)' },
          ),
        );
      }
    }
    laneIntro.value = false;
    const lane = root.value.querySelector('.sr-lane');
    if (lane instanceof HTMLElement && typeof lane.animate === 'function') {
      answerAnimations.push(
        lane.animate(
          [
            { opacity: 0, transform: 'translateX(6px)', filter: 'blur(3px)' },
            { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' },
          ],
          { duration: 300, delay: PICK_MS, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' },
        ),
      );
    }
    const ghostEl = root.value.querySelector('.sr-ghost');
    if (ghostEl instanceof HTMLElement && typeof ghostEl.animate === 'function') {
      answerAnimations.push(
        ghostEl.animate(
          [
            { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' },
            { opacity: 0, transform: 'translateX(-4px)', filter: 'blur(3px)' },
          ],
          { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' },
        ),
      );
    }
    track(setTimeout(land, FLY_MS));
    track(
      setTimeout(() => {
        ghost.value = null;
      }, GHOST_FADE_MS),
    );
    if (focusUndoAfterFlight) {
      focusUndoAfterFlight = false;
      moveFocusToUndo();
    }
  });
}

function land(): void {
  flying.value = false;
  landing.value = true;
  bursting.value = true;
  track(
    setTimeout(() => {
      landing.value = false;
    }, LAND_CLASS_MS),
  );
  track(
    setTimeout(() => {
      bursting.value = false;
    }, BURST_MS),
  );
  track(
    setTimeout(() => {
      blinking.value = true;
      track(
        setTimeout(() => {
          blinking.value = false;
        }, BLINK_CLASS_MS),
      );
    }, BLINK_AT_MS),
  );
}

function resetToQuestion(): void {
  clearAnswer();
  stage.value = 'question';
  picked.value = undefined;
  flying.value = false;
  landing.value = false;
  blinking.value = false;
  bursting.value = false;
  laneIntro.value = false;
  ghost.value = null;
  focusUndoAfterFlight = false;
  entering.value = true;
  afterPaint(() => {
    entering.value = false;
  });
}

function moveFocusToUndo(): void {
  void nextTick(() => {
    root.value?.querySelector<HTMLElement>('.sr-undo')?.focus();
  });
}

function choose(response: AppSessionRatingResponse): void {
  if (!armed.value || props.view.phase !== 'open') return;
  emit('select', response);
}

function undo(): void {
  if (props.view.phase === 'pending') emit('undo');
}

function faceButtons(): HTMLButtonElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLButtonElement>('.sr-face') ?? []);
}

function moveFocus(delta: number): void {
  const buttons = faceButtons();
  if (buttons.length === 0) return;
  const current = buttons.findIndex((button) => button === document.activeElement);
  const next = current === -1 ? (delta > 0 ? 0 : buttons.length - 1) : (current + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (props.view.phase !== 'pending') return;
    event.preventDefault();
    event.stopPropagation();
    undo();
    return;
  }
  if (props.view.phase !== 'open') return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    moveFocus(event.key === 'ArrowRight' ? 1 : -1);
  }
}
</script>

<template>
  <div
    ref="root"
    class="session-rating"
    :class="{ armed, standalone, enter: entering, picking: stage === 'picking', settled: view.phase === 'thanks' }"
    role="group"
    :aria-label="t('conversation.sessionRatingQuestion')"
    @keydown="onKeydown"
  >
    <template v-if="stage !== 'result'">
      <span class="sr-question">{{ t('conversation.sessionRatingQuestion') }}</span>
      <Tooltip v-for="response in RESPONSES" :key="response" :text="t(LABEL_KEYS[response])">
        <button
          class="sr-face"
          :class="{ picked: picked === response }"
          type="button"
          :aria-label="t(LABEL_KEYS[response])"
          :data-response="response"
          @click="choose(response)"
        >
          <svg class="kimi-face" viewBox="0 0 24 24" aria-hidden="true">
            <rect class="kf-head" x="2.5" y="5.5" width="19" height="13" rx="4.5" />
            <path class="kf-eye" :d="EYES[response][0]" />
            <path class="kf-eye" :d="EYES[response][1]" />
          </svg>
        </button>
      </Tooltip>
    </template>
    <template v-else-if="chosen">
      <span class="sr-chosen" :aria-label="t(LABEL_KEYS[chosen])">
        <svg
          class="kimi-face"
          :class="{ solid: !flying, flying, land: landing, blink: blinking }"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect class="kf-head" x="2.5" y="5.5" width="19" height="13" rx="4.5" />
          <path class="kf-eye" :d="EYES[chosen][0]" />
          <path class="kf-eye" :d="EYES[chosen][1]" />
        </svg>
        <span v-if="bursting" class="sr-burst" aria-hidden="true">
          <i class="sr-ring" />
          <i
            v-for="spark in SPARKS"
            :key="spark.angle"
            class="sr-p"
            :class="{ dot: spark.dot }"
            :style="{ '--a': spark.angle, '--d': spark.distance }"
          />
        </span>
      </span>
      <span class="sr-lane" :class="{ intro: laneIntro }">
        <span class="sr-thanks" role="status">{{ t('conversation.sessionRatingThanks') }}</span>
        <Button
          class="sr-undo"
          variant="ghost"
          size="xs"
          :disabled="view.phase === 'thanks'"
          :aria-hidden="view.phase === 'thanks' ? true : undefined"
          @click="undo"
        >
          {{ t('conversation.sessionRatingUndo') }}
        </Button>
      </span>
    </template>
    <span v-if="ghost" class="sr-ghost" :style="{ left: `${ghost.left}px`, top: `${ghost.top}px` }">{{ ghost.text }}</span>
  </div>
</template>

<style scoped>
.session-rating,
.sr-lane {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}

.session-rating {
  position: relative;
  height: 20px;
  box-sizing: border-box;
  padding-left: 10px;
  border-left: var(--p-hairline) solid var(--color-line);
  transition:
    opacity var(--duration-slow) var(--ease-out),
    transform var(--duration-slow) var(--ease-out);
}

.session-rating.standalone {
  padding-left: 0;
  border-left: 0;
}

.session-rating.enter {
  opacity: 0;
  transform: translateX(-6px);
}

.sr-question,
.sr-thanks {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: 20px;
  white-space: nowrap;
}

.sr-ghost {
  position: absolute;
  white-space: nowrap;
  pointer-events: none;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  transform-origin: left center;
}

.sr-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  cursor: pointer;
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.session-rating:not(.armed) .sr-face {
  cursor: default;
}

.session-rating.picking .sr-face:not(.picked) {
  opacity: 0;
  transform: scale(0.82);
}

.session-rating.picking .sr-face.picked .kimi-face {
  color: var(--logo);
}

.sr-face:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.sr-chosen {
  position: relative;
  display: inline-flex;
}

.sr-lane.intro {
  opacity: 0;
  transform: translateX(8px);
}

.kimi-face {
  display: block;
  width: 20px;
  height: 20px;
  flex: none;
  color: var(--color-text-faint);
  overflow: visible;
  transition:
    color var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.kf-head {
  fill: transparent;
  stroke: currentColor;
  stroke-width: 1;
  transition: fill 220ms var(--ease-out);
}

.kf-eye {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform-box: fill-box;
  transform-origin: center;
  transition: stroke 220ms var(--ease-out);
}

.armed .sr-face:hover .kimi-face {
  color: var(--logo);
  transform: translateY(-1px);
}

.armed .sr-face:hover .kf-head {
  fill: var(--color-accent-soft);
}

.kimi-face.flying {
  color: var(--logo);
}

.kimi-face.flying .kf-head {
  fill: var(--color-bg);
}

.kimi-face.solid {
  color: var(--logo);
}

.kimi-face.solid .kf-head {
  fill: currentColor;
}

.kimi-face.solid .kf-eye {
  stroke: var(--color-text-on-accent);
  stroke-width: 1.5;
}

.kimi-face.land {
  animation: sr-land 480ms cubic-bezier(0.3, 1.5, 0.5, 1);
}

@keyframes sr-land {
  0% { transform: scale(1); }
  28% { transform: scale(1.24, 0.84); }
  58% { transform: scale(0.93, 1.07); }
  100% { transform: scale(1); }
}

.kimi-face.blink .kf-eye {
  animation: sr-blink 260ms ease-in-out;
}

@keyframes sr-blink {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.15); }
}

.sr-burst {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  pointer-events: none;
}

.sr-ring {
  position: absolute;
  left: -15px;
  top: -15px;
  width: 30px;
  height: 30px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 1.5px solid var(--logo);
  opacity: 0;
  animation: sr-ring 640ms var(--ease-out) forwards;
}

@keyframes sr-ring {
  0% { transform: scale(0.45); opacity: 0.7; }
  100% { transform: scale(1.45); opacity: 0; }
}

.sr-p {
  position: absolute;
  left: -1px;
  top: -3px;
  width: 2px;
  height: 6px;
  border-radius: 1px;
  background: var(--logo);
  opacity: 0;
  animation: sr-spark 600ms var(--ease-out) forwards;
}

.sr-p.dot {
  left: -2px;
  top: -2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
}

@keyframes sr-spark {
  0% { opacity: 1; transform: rotate(var(--a)) translateY(-9px) scale(1); }
  100% { opacity: 0; transform: rotate(var(--a)) translateY(var(--d, -21px)) scale(0.5); }
}

@media (prefers-reduced-motion: reduce) {
  .kimi-face.land,
  .kimi-face.blink .kf-eye,
  .sr-burst {
    animation: none;
    display: none;
  }
}

.sr-undo {
  height: 20px;
  padding: 0 var(--space-1-5);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  transition:
    opacity var(--duration-slow) var(--ease-out),
    transform var(--duration-slow) var(--ease-out);
}

.session-rating.settled .sr-undo {
  opacity: 0;
  pointer-events: none;
}
</style>
