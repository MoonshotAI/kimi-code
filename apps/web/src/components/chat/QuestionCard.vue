<!-- apps/kimi-web/src/components/chat/QuestionCard.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UIQuestion } from '../../types';
import type { QuestionAnswer, QuestionResponse } from '../../api/types';
import { Markdown } from '@moonshot-ai/app-markdown';
import { Button, Icon, IconButton, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';

const props = defineProps<{
  question: UIQuestion;
  /** Action kind currently in flight for this question. Drives the
   *  submit/dismiss loading state and blocks duplicate actions while the
   *  daemon processes the response. */
  busyKind?: 'answer' | 'dismiss';
}>();

const { t } = useI18n();

const emit = defineEmits<{
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
}>();

// ---------------------------------------------------------------------------
// Multi-question navigation
// ---------------------------------------------------------------------------

const step = ref(0);

// Temporarily collapse the card to a thin bar so it stops covering the chat
// while the user reads. State is local — answers/step are kept either way.
const minimized = ref(false);

// The whole minimized bar is a click target — not just the chevron icon.
function expandFromBar(): void {
  if (minimized.value) minimized.value = false;
}

const current = computed(() => props.question.questions[step.value]!);
const total = computed(() => props.question.questions.length);

function goBack(): void {
  if (step.value > 0) step.value--;
}

function goNext(): void {
  if (step.value < total.value - 1) step.value++;
}

function isQuestionAnswered(qid: string): boolean {
  const a = answers.value[qid];
  if (!a) return false;
  if (a.kind === 'multi') return a.optionIds.length > 0;
  if (a.kind === 'multiWithOther') return a.optionIds.length > 0 || a.otherText.trim().length > 0;
  if (a.kind === 'other') return a.text.trim().length > 0;
  return true;
}

function isCurrentAnswered(): boolean {
  return isQuestionAnswered(current.value.id);
}

// ---------------------------------------------------------------------------
// Per-question answers: Record<questionId, QuestionAnswer>
// ---------------------------------------------------------------------------

const answers = ref<Record<string, QuestionAnswer>>({});

function isRecommendedOption(option: { label: string; description?: string; recommended?: boolean }): boolean {
  if (option.recommended === true) return true;
  return /\b(?:recommended|recommend)\b|推荐/.test(`${option.label} ${option.description ?? ''}`.toLowerCase());
}

function seedRecommendedAnswers(): void {
  const next = { ...answers.value };
  let changed = false;
  for (const q of props.question.questions) {
    if (next[q.id]) continue;
    const recommended = q.options.filter(isRecommendedOption);
    if (recommended.length === 0) continue;
    next[q.id] = q.multiSelect
      ? { kind: 'multi', optionIds: recommended.map((option) => option.id) }
      : { kind: 'single', optionId: recommended[0]!.id };
    changed = true;
  }
  if (changed) answers.value = next;
}

watch(
  () => props.question.questionId,
  () => {
    step.value = 0;
    minimized.value = false;
    answers.value = {};
    otherTexts.value = {};
  },
);

watch(
  () => props.question,
  () => {
    if (step.value >= props.question.questions.length) step.value = 0;
    seedRecommendedAnswers();
  },
  { immediate: true, deep: true },
);

// Single-select: pick one optionId
function pickSingle(qid: string, optionId: string): void {
  const cur = answers.value[qid];
  // toggle off if already selected (allow deselect)
  if (cur && cur.kind === 'single' && cur.optionId === optionId) {
    const next = { ...answers.value };
    delete next[qid];
    answers.value = next;
  } else {
    answers.value = { ...answers.value, [qid]: { kind: 'single', optionId } };
  }
}

// Multi-select: toggle an optionId
function toggleMulti(qid: string, optionId: string): void {
  const cur = answers.value[qid];
  const ids: string[] = cur && (cur.kind === 'multi' || cur.kind === 'multiWithOther')
    ? (cur.kind === 'multi' ? [...cur.optionIds] : [...cur.optionIds])
    : [];
  const idx = ids.indexOf(optionId);
  if (idx >= 0) { ids.splice(idx, 1); } else { ids.push(optionId); }

  const existing = answers.value[qid];
  const otherText = existing && existing.kind === 'multiWithOther' ? existing.otherText : '';
  if (otherText) {
    answers.value = { ...answers.value, [qid]: { kind: 'multiWithOther', optionIds: ids, otherText } };
  } else {
    answers.value = { ...answers.value, [qid]: { kind: 'multi', optionIds: ids } };
  }
}

// "Other" text input (single)
const otherTexts = ref<Record<string, string>>({});

// Ref to the current question's "Other" input so clicking the option row can
// focus it. Only the visible step's input is rendered at a time, so a single
// ref suffices.
const otherInputEl = ref<HTMLInputElement | null>(null);

function pickOther(qid: string): void {
  const q = props.question.questions.find((qi) => qi.id === qid)!;
  const text = otherTexts.value[qid] ?? '';
  if (q.multiSelect) {
    const cur = answers.value[qid];
    const ids: string[] = cur && (cur.kind === 'multi' || cur.kind === 'multiWithOther')
      ? (cur.kind === 'multi' ? [...cur.optionIds] : [...cur.optionIds])
      : [];
    answers.value = { ...answers.value, [qid]: { kind: 'multiWithOther', optionIds: ids, otherText: text } };
  } else {
    answers.value = { ...answers.value, [qid]: { kind: 'other', text } };
  }
}

// Select the "Other" option (so its radio/checkbox turns on) and focus the
// text input so the user can type immediately. Triggered by clicking anywhere
// on the option row, not just the input.
function selectOther(qid: string): void {
  pickOther(qid);
  nextTick(() => otherInputEl.value?.focus());
}

function isSelected(qid: string, optionId: string): boolean {
  const cur = answers.value[qid];
  if (!cur) return false;
  if (cur.kind === 'single') return cur.optionId === optionId;
  if (cur.kind === 'multi') return cur.optionIds.includes(optionId);
  if (cur.kind === 'multiWithOther') return cur.optionIds.includes(optionId);
  return false;
}

function isOtherSelected(qid: string): boolean {
  const cur = answers.value[qid];
  return !!(cur && (cur.kind === 'other' || cur.kind === 'multiWithOther'));
}

function canSubmit(): boolean {
  // All questions must have an answer
  return props.question.questions.every((qi) => isQuestionAnswered(qi.id));
}

// ---------------------------------------------------------------------------
// Submit / dismiss
// ---------------------------------------------------------------------------

// An action is in flight for this card (the daemon is processing our answer or
// dismiss). While busy, the triggered button shows a spinner and the rest are
// disabled so a second click can't fire a duplicate request.
const submitting = computed(() => props.busyKind === 'answer');
const dismissing = computed(() => props.busyKind === 'dismiss');
const busy = computed(() => !!props.busyKind);

function submit(): void {
  if (busy.value || !canSubmit()) return;
  const response: QuestionResponse = {
    answers: answers.value,
    method: 'click',
  };
  emit('answer', props.question.questionId, response);
}

function dismiss(): void {
  if (busy.value) return;
  emit('dismiss', props.question.questionId);
}

// ---------------------------------------------------------------------------
// Keyboard: number keys pick options for current question, Enter submit, Esc dismiss
// ---------------------------------------------------------------------------

// Highlighted option index for ↑/↓ keyboard navigation. Single-select moves
// the selection itself with the arrows; multi-select moves only the highlight
// and Space toggles. Reset whenever the visible question changes.
const highlight = ref(0);
// The reset below zeroes the highlight, which fires the keyboard-follow
// watcher in the same flush — and same-flush nextTick callbacks run in
// watcher creation order, so that follow would execute AFTER the paging
// scroll reset and redundantly pull row 0 (the new highlight) back into
// view. Consume exactly one follow per reset that actually moves the
// highlight, so paging's top-of-body reset stays the last word.
let suppressKeyScrollFollow = false;
watch([step, () => props.question.questionId], () => {
  if (highlight.value !== 0) suppressKeyScrollFollow = true;
  highlight.value = 0;
});

// Root element: keyboard scroll-into-view and per-question scroll resets need
// the card's two scroll containers (the body scroller and, when even the
// fixed chrome overflows the viewport cap, the card itself).
const cardEl = ref<HTMLElement | null>(null);

// Keep the keyboard row inside the scrollport: ↑/↓ (and digit picks) move the
// highlight — or the selection itself in single-select — which may sit
// outside the visible band once the card is viewport-capped and the body
// scrolls. The row is scrolled into the body's scrollport first, then into
// the card's own (the fallback scroller is active when the chrome alone
// exhausts the budget, which can push the whole body out of view). Manual
// scrollTop math — scrollIntoView would also scroll ancestor scrollers (the
// transcript behind the card). The watcher on `highlight` below covers only
// moves; keys that leave the highlight in place (re-pressing the highlighted
// row's digit, Space in multi-select, a boundary ↑/↓) call scrollKeyRowIntoView
// from the key handler itself.
function scrollIntoScrollport(scroller: HTMLElement, el: HTMLElement): void {
  const scrollerRect = scroller.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const top = elRect.top - scrollerRect.top + scroller.scrollTop;
  const bottom = top + elRect.height;
  // An element taller than the scrollport aligns by its top edge — for an
  // option row that keeps the number chip, glyph and label visible instead
  // of aligning the row's bottom and hiding which answer is highlighted.
  if (elRect.height >= scroller.clientHeight || top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
}

function scrollKeyRowIntoView(): void {
  const card = cardEl.value;
  const body = card?.querySelector<HTMLElement>('.qbody');
  if (!card || !body) return;
  // Locate the row by highlight index, not by visual state: single-select
  // rows never get .highlighted, and re-picking the current answer (a digit
  // re-press, or arrowing onto a pre-selected option) toggles it OFF — the
  // row has neither class right when the explicit follow needs it. The
  // option rows and the trailing "Other" row are all .qopt, in highlight
  // order.
  const row = body.querySelectorAll<HTMLElement>('.qopt')[highlight.value];
  if (!row) return;
  scrollIntoScrollport(body, row);
  scrollIntoScrollport(card, row);
}

watch(highlight, () => {
  if (suppressKeyScrollFollow) {
    suppressKeyScrollFollow = false;
    return;
  }
  void nextTick(scrollKeyRowIntoView);
});

// Paging between questions reuses the same .qbody/.qcard nodes — reset both
// scroll containers so the next question starts at its top instead of
// inheriting the previous question's scroll position.
watch(step, () => {
  void nextTick(() => {
    const body = cardEl.value?.querySelector<HTMLElement>('.qbody');
    if (body) body.scrollTop = 0;
    if (cardEl.value) cardEl.value.scrollTop = 0;
  });
});

// IME guard: while composing in the "Other" field every keystroke belongs to
// the IME — Enter confirming a candidate must not advance/submit the card.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea';
  // Bare-key conveniences only: a modified chord (⌘Enter, Ctrl+1, …) belongs
  // to the shortcut system or the browser, never to the card.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // While an answer/dismiss is in flight, ignore shortcuts so a stray Enter
  // can't fire a duplicate submit.
  if (busy.value) return;
  if (isComposingKeyEvent(e)) return;
  // A modal dialog/lightbox owns the whole keyboard — Enter included. No card
  // shortcut fires through it (the Esc branch adds a defaultPrevented check).
  if (openDialogCount.value > 0) return;

  // Enter advances to the next question (or submits when all are answered).
  // Allowed even while focus is in the "Other" text input, but not while the
  // card is minimized — the options aren't visible, so don't submit blindly.
  if (e.key === 'Enter') {
    e.preventDefault();
    if (minimized.value) return;
    if (step.value < total.value - 1 && isCurrentAnswered()) {
      goNext();
    } else if (canSubmit()) {
      submit();
    }
    return;
  }

  // Escape dismisses; number keys pick options. Both are suppressed while
  // typing in a field so the keystrokes go to the input instead.
  if (inField) return;
  if (e.key === 'Escape') {
    // A modal dialog owns Escape (it closes that dialog); an earlier handler
    // may already have consumed the key. Don't dismiss the card under either.
    if (openDialogCount.value > 0 || e.defaultPrevented) return;
    e.preventDefault();
    dismiss();
    return;
  }
  // While minimized the options aren't visible, so don't let keys pick an
  // unseen answer.
  if (minimized.value) return;

  // ↑/↓ navigation: single-select moves the selection itself; multi-select
  // moves only the highlight (Space toggles). No wraparound — the highlight
  // stops at the first/last row.
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const q = current.value;
    const count = q.options.length + (q.allowOther ? 1 : 0);
    if (count === 0) return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(count - 1, Math.max(0, highlight.value + delta));
    // Clamped at the first/last row: the highlight didn't move, so don't
    // re-pick — pickSingle toggles an already-selected option off, which would
    // clear the answer on a boundary keypress. Still scroll the boundary row
    // back into view — the watcher only fires on moves, and the user may have
    // scrolled that row out of the body by hand.
    if (next === highlight.value) {
      void nextTick(scrollKeyRowIntoView);
      return;
    }
    highlight.value = next;
    const opt = q.options[highlight.value];
    if (opt) {
      if (!q.multiSelect) pickSingle(q.id, opt.id);
    } else if (q.allowOther && !q.multiSelect) {
      // Landing on "Other" selects it, but does NOT focus the input — the
      // user keeps arrowing / hits Enter without the field stealing the keys.
      pickOther(q.id);
    }
    return;
  }
  if (e.key === ' ' && current.value.multiSelect) {
    e.preventDefault();
    const q = current.value;
    const opt = q.options[highlight.value];
    if (opt) {
      toggleMulti(q.id, opt.id);
      // Space never moves the highlight, so the watcher can't follow — bring
      // the toggled row back into view after a manual scroll away from it.
      void nextTick(scrollKeyRowIntoView);
    } else if (q.allowOther) {
      pickOther(q.id);
      void nextTick(scrollKeyRowIntoView);
    }
    return;
  }

  const num = parseInt(e.key, 10);
  if (!isNaN(num) && num >= 1 && num <= 9) {
    e.preventDefault();
    const q = current.value;
    const optIdx = num - 1;
    const opt = q.options[optIdx];
    if (opt) {
      highlight.value = optIdx;
      if (q.multiSelect) {
        toggleMulti(q.id, opt.id);
      } else {
        pickSingle(q.id, opt.id);
      }
      // Re-pressing the highlighted row's digit leaves the highlight
      // unchanged, so the watcher can't follow — scroll explicitly (a no-op
      // duplicate when the highlight did move and the watcher scheduled one).
      void nextTick(scrollKeyRowIntoView);
    }
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div ref="cardEl" class="qcard" :class="{ minimized }">
    <!-- Header: the question itself is the title (step chip when there are
         several), minimize + dismiss pinned right. Same card language as the
         approval card. -->
    <div class="qh" :class="{ clickable: minimized }" @click="expandFromBar">
      <span v-if="total > 1" class="qh-chip">{{ step + 1 }}</span>
      <span class="qtitle">{{ current.question }}</span>
      <IconButton
        class="qmin"
        size="sm"
        :label="minimized ? t('question.expand') : t('question.minimize')"
        :tooltip="minimized ? t('question.expand') : t('question.minimize')"
        @click.stop="minimized = !minimized"
      >
        <Icon v-if="minimized" name="chevron-up" size="md" />
        <Icon v-else name="minus" size="md" />
      </IconButton>
      <IconButton
        class="qclose"
        size="sm"
        :label="t('question.dismiss')"
        :tooltip="t('question.dismiss')"
        :disabled="busy"
        @click.stop="dismiss"
      >
        <Icon name="close" size="md" />
      </IconButton>
    </div>

    <template v-if="!minimized">
      <!-- Current question -->
      <div class="qbody">
        <!-- Body markdown -->
        <Markdown v-if="current.body" :text="current.body" class="qmdbody" />

        <!-- Options: borderless numbered rows, hover fill, CSS radio/checkbox.
             ↑/↓ navigates (multi-select shows a persistent highlight row). -->
        <div class="qopts">
          <label
            v-for="(opt, oi) in current.options"
            :key="opt.id"
            class="qopt"
            :class="{ selected: isSelected(current.id, opt.id), highlighted: current.multiSelect && oi === highlight }"
            @click.prevent="highlight = oi; current.multiSelect ? toggleMulti(current.id, opt.id) : pickSingle(current.id, opt.id)"
          >
            <span class="qopt-key">{{ oi + 1 }}</span>
            <span class="qopt-glyph" :class="current.multiSelect ? 'chk' : 'rad'"></span>
            <span class="qopt-text">
              <span class="qopt-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="qopt-desc">{{ opt.description }}</span>
            </span>
          </label>

          <!-- Other option -->
          <label
            v-if="current.allowOther"
            class="qopt"
            :class="{ selected: isOtherSelected(current.id), highlighted: current.multiSelect && highlight === current.options.length }"
            @click.prevent="highlight = current.options.length; selectOther(current.id)"
          >
            <span class="qopt-key"></span>
            <span class="qopt-glyph" :class="current.multiSelect ? 'chk' : 'rad'"></span>
            <span class="qopt-label">{{ current.otherLabel ?? t('question.otherDefault') }}</span>
            <input
              ref="otherInputEl"
              v-model="otherTexts[current.id]"
              class="other-input"
              type="text"
              :placeholder="current.otherLabel ?? t('question.otherDefault')"
              @input="pickOther(current.id)"
              @focus="pickOther(current.id)"
              @compositionstart="handleCompositionStart"
              @compositionend="handleCompositionEnd"
            />
          </label>
        </div>
      </div>

      <!-- Footer: same contract as the approval card — actions left-aligned
           with the solid dark primary first, quiet ghosts after; the
           keyboard hint is pinned to the right edge. -->
      <div class="qfoot">
        <div class="qbtns">
          <Button
            v-if="step < total - 1"
            class="qmain"
            size="md"
            variant="primary"
            :disabled="!isCurrentAnswered()"
            @click="goNext"
          >{{ t('question.nextQuestion') }}</Button>
          <Button
            v-else
            class="qmain"
            size="md"
            variant="primary"
            :disabled="!canSubmit()"
            :loading="submitting"
            @click="submit"
          >{{ t('question.submit') }}</Button>
          <Button
            v-if="total > 1"
            size="md"
            variant="ghost"
            :disabled="step === 0 || busy"
            @click="goBack"
          >{{ t('question.back') }}</Button>
          <Button size="md" variant="ghost" :loading="dismissing" :disabled="busy" @click="dismiss">{{ t('question.dismiss') }}</Button>
        </div>
        <span class="qhint">{{ t('question.hint') }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Floating neutral card — same language as the approval card: white surface,
   hairline border, quiet radius, faint popover shadow above the transcript.
   Flex column capped just below the chat header, again like the approval
   card: the title now wraps in full, so an uncapped card could grow past the
   top of the bottom-anchored dock and push the question's start and the
   minimize/dismiss buttons out of reach. The cap follows the VISUAL viewport
   (--app-height mirrors visualViewport.height, see App.vue's setAppHeight);
   .qbody is the internal scroll region, and overflow-y: auto on the card
   itself is the scroller of last resort when even the fixed chrome exceeds
   the cap. */
.qcard {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
  margin: var(--space-2) 0;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  overflow: hidden auto;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
.qcard > .qh,
.qcard > .qfoot { flex: none; }
/* Minimized bar: subtle hover fill as the click affordance. */
.qcard.minimized { transition: background var(--duration-fast) var(--ease-out); }
.qcard.minimized:hover { background: var(--color-hover); }

/* Header — the question itself is the title, wrapping in full; step chip
   when there are several questions, minimize + dismiss pinned right. */
.qh {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}
.qcard.minimized .qh { padding-bottom: var(--space-3); align-items: center; }
/* Minimized: the whole bar is the expand target. */
.qcard.minimized .qh.clickable { cursor: pointer; }
/* Step chip — same number-chip vocabulary as the option rows. */
.qh-chip {
  width: var(--p-chip-num);
  height: var(--p-chip-num);
  border-radius: var(--radius-sm);
  background: var(--color-inline-code-bg);
  color: var(--color-text);
  font: var(--weight-medium) var(--text-xs)/var(--p-chip-num) var(--font-ui);
  text-align: center;
  flex: none;
}
.qtitle {
  flex: 1;
  min-width: 0;
  color: var(--color-text);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  /* Full-wrap contract: break anywhere so an unbroken run (hash, generated
     id, base64) wraps instead of being clipped by the card's overflow. */
  overflow-wrap: anywhere;
}
/* Minimized → single-line ellipsis. */
.qcard.minimized .qtitle {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Header icon buttons — pinned right, optically centred on the title's first
   line (--text-lg × --leading-tight vs the sm IconButton box). */
.qmin,
.qclose {
  flex: none;
  margin-top: calc((var(--text-lg) * var(--leading-tight) - var(--icon-button-sm)) / 2);
}
.qmin { margin-left: auto; }
.qcard.minimized .qmin { margin-top: 0; }
.qcard.minimized .qclose { margin-top: 0; }

/* Body — internal scroll region once the card hits its viewport cap. The
   floor keeps the options reachable when the fixed chrome (a very long title
   plus the footer) exhausts the budget on its own: instead of collapsing to
   zero and clipping the options inside an unscrollable sliver, the body keeps
   an operable height and the card-level scroller takes over. */
.qbody {
  min-height: min(var(--question-card-body-min-h), calc(var(--app-height, 100dvh) * 0.25));
  overflow-y: auto;
  padding: var(--space-3) var(--space-4) 0;
  color: var(--color-text);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}

.qmdbody { margin-bottom: var(--space-2); }

/* Options — borderless rows with a hover fill; the number chip doubles as the
   number-key hint. */
.qopts { display: flex; flex-direction: column; gap: 2px; margin-top: var(--space-2); }

.qopt {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  transition: background var(--duration-fast) var(--ease-out);
  user-select: none;
}
.qopt:hover { background: var(--color-hover); }
/* Multi-select keyboard highlight (↑/↓) — same fill as hover, persistent. */
.qopt.highlighted { background: var(--color-hover); }

/* Number chip and radio/checkbox glyph top-align with the option text block;
   a small offset optically centres each on the label's first line
   (--text-base × --leading-normal), same idiom as the header icon buttons. */
.qopt-key {
  width: var(--p-chip-num);
  height: var(--p-chip-num);
  margin-top: calc((var(--text-base) * var(--leading-normal) - var(--p-chip-num)) / 2);
  border-radius: var(--radius-sm);
  background: var(--color-inline-code-bg);
  color: var(--color-text);
  font: var(--weight-medium) var(--text-xs)/var(--p-chip-num) var(--font-ui);
  text-align: center;
  flex: none;
}
.qopt-key:empty {
  background: transparent;
}

/* CSS radio / checkbox glyphs — quiet outline, accent fill when selected. */
.qopt-glyph {
  width: 16px;
  height: 16px;
  margin-top: calc((var(--text-base) * var(--leading-normal) - 16px) / 2);
  flex: none;
  border: 0.5px solid var(--color-line-strong);
  position: relative;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.qopt-glyph.rad { border-radius: 50%; }
.qopt-glyph.chk { border-radius: var(--radius-xs); }
.qopt.selected .qopt-glyph { border-color: var(--color-accent); }
.qopt.selected .qopt-glyph.rad::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--color-accent);
}
.qopt.selected .qopt-glyph.chk { background: var(--color-accent); }
.qopt.selected .qopt-glyph.chk::after {
  content: '';
  position: absolute;
  left: 4.5px;
  top: 1.5px;
  width: 4px;
  height: 8px;
  border-right: 1.5px solid var(--color-text-on-accent);
  border-bottom: 1.5px solid var(--color-text-on-accent);
  transform: rotate(45deg);
}

/* Label on the first line, description always on its own second line — fully
   readable, no truncation, no ragged inline wrap. */
.qopt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.qopt-label {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.qopt-desc {
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
}

.other-input {
  flex: 1;
  font: var(--text-base) var(--font-ui);
  border: none;
  border-bottom: 0.5px solid var(--color-line);
  outline: none;
  padding: 2px var(--space-1);
  color: var(--color-text);
  background: transparent;
  min-width: 0;
}
.other-input:focus-visible {
  border-bottom-color: var(--color-accent);
  box-shadow: 0 1px 0 0 var(--color-accent);
}

/* Footer — hairline-separated: actions left-aligned in the approval card's
   order (solid dark primary first, quiet ghosts after), keyboard hint pinned
   to the right edge. */
.qfoot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 0.5px solid var(--color-line);
}
.qbtns {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.qhint {
  margin-left: auto;
  color: var(--color-text-faint);
  font: var(--text-xs) var(--font-ui);
  user-select: none;
}

/* =========================================================================
   MOBILE (≤640px): bigger option taps, comfortable nav, and full-width footer
   buttons that are ≥44px tall so Submit/Dismiss are easy to hit. The card is
   already full-width inside ConversationPane; we only resize controls.
   ========================================================================= */
@media (max-width: 640px) {
  /* Options → taller, finger-friendly rows. */
  .qopt {
    min-height: 44px;
    padding: var(--space-3);
  }
  .other-input { flex-basis: 100%; min-height: 28px; }

  /* Footer → full-width stacked buttons; the primary is already first in DOM
     order, so it lands on top. */
  .qfoot { flex-direction: column; align-items: stretch; }
  .qhint { display: none; }
  .qbtns { flex-direction: column; gap: var(--space-2); }
  .qbtns :deep(.ui-button) {
    width: 100%;
    min-height: 46px;
  }
}
</style>
