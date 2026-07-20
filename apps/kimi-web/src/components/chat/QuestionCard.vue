<!-- apps/kimi-web/src/components/chat/QuestionCard.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UIQuestion } from '../../types';
import type { QuestionAnswer, QuestionResponse } from '../../api/types';
import Markdown from './Markdown.vue';
import Card from '../ui/Card.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';

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

const current = computed(() => props.question.questions[step.value]!);
const total = computed(() => props.question.questions.length);

function goBack(): void {
  if (step.value > 0) step.value--;
}

function goNext(): void {
  if (step.value < total.value - 1) step.value++;
}

function goToStep(index: number): void {
  if (index >= 0 && index < total.value) step.value = index;
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

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea';
  // While an answer/dismiss is in flight, ignore shortcuts so a stray Enter
  // can't fire a duplicate submit.
  if (busy.value) return;

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
  if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
  // While minimized the options aren't visible, so don't let number keys pick
  // an unseen answer.
  if (minimized.value) return;

  const num = parseInt(e.key, 10);
  if (!isNaN(num) && num >= 1 && num <= 9) {
    e.preventDefault();
    const q = current.value;
    const optIdx = num - 1;
    const opt = q.options[optIdx];
    if (opt) {
      if (q.multiSelect) {
        toggleMulti(q.id, opt.id);
      } else {
        pickSingle(q.id, opt.id);
      }
    }
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Card class="qcard" :class="{ minimized }">
    <!-- Header: semantic icon + title, step count, minimize -->
    <template #head>
      <div class="qh">
        <span class="qh-ic">?</span>
        <span class="qtitle">{{ t('question.title') }}</span>
        <span v-if="total > 1 && !minimized" class="qstep">{{ t('question.step', { current: step + 1, total }) }}</span>
        <!-- When minimized, surface the question text so the bar stays identifiable -->
        <span v-if="minimized" class="qmin-peek">{{ current.question }}</span>
        <IconButton
          class="qmin"
          size="sm"
          :label="minimized ? t('question.expand') : t('question.minimize')"
          @click="minimized = !minimized"
        >
          <Icon v-if="minimized" name="chevron-up" size="md" />
          <Icon v-else name="minus" size="md" />
        </IconButton>
      </div>
    </template>

    <!-- Current question -->
    <template v-if="!minimized" #default>
      <div class="qbody">
        <!-- Stepper: only shown when there are multiple questions -->
        <div v-if="total > 1" class="qsteps" role="tablist" :aria-label="t('question.step', { current: step + 1, total })">
          <button
            v-for="(q, i) in props.question.questions"
            :key="q.id"
            type="button"
            class="qstep-dot"
            :class="{ active: i === step, answered: isQuestionAnswered(q.id) }"
            :aria-selected="i === step"
            :aria-label="t('question.step', { current: i + 1, total })"
            @click="goToStep(i)"
          >
            <span class="qstep-num">{{ i + 1 }}</span>
          </button>
        </div>

        <!-- Header chip -->
        <div v-if="current.header" class="qheader-chip">
          <Badge variant="neutral" size="sm">{{ current.header }}</Badge>
        </div>

        <!-- Question text -->
        <div class="qtext">{{ current.question }}</div>

        <!-- Body markdown -->
        <Markdown v-if="current.body" :text="current.body" class="qmdbody" />

        <!-- Options -->
        <div class="qopts">
          <label
            v-for="(opt, oi) in current.options"
            :key="opt.id"
            class="qopt"
            :class="{ selected: isSelected(current.id, opt.id) }"
            @click.prevent="current.multiSelect ? toggleMulti(current.id, opt.id) : pickSingle(current.id, opt.id)"
          >
            <span class="qopt-key">{{ oi + 1 }}</span>
            <span class="qopt-glyph">
              <template v-if="current.multiSelect">
                <span class="chk">{{ isSelected(current.id, opt.id) ? '■' : '□' }}</span>
              </template>
              <template v-else>
                <span class="rad">{{ isSelected(current.id, opt.id) ? '●' : '○' }}</span>
              </template>
            </span>
            <span class="qopt-text">
              <span class="qopt-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="qopt-desc">{{ opt.description }}</span>
            </span>
          </label>

          <!-- Other option -->
          <label
            v-if="current.allowOther"
            class="qopt"
            :class="{ selected: isOtherSelected(current.id) }"
            @click.prevent="selectOther(current.id)"
          >
            <span class="qopt-key"></span>
            <span class="qopt-glyph">
              <template v-if="current.multiSelect">
                <span class="chk">{{ isOtherSelected(current.id) ? '■' : '□' }}</span>
              </template>
              <template v-else>
                <span class="rad">{{ isOtherSelected(current.id) ? '●' : '○' }}</span>
              </template>
            </span>
            <span class="qopt-label">{{ current.otherLabel ?? t('question.otherDefault') }}</span>
            <input
              ref="otherInputEl"
              v-model="otherTexts[current.id]"
              class="other-input"
              type="text"
              :placeholder="current.otherLabel ?? t('question.otherDefault')"
              @input="pickOther(current.id)"
              @focus="pickOther(current.id)"
            />
          </label>
        </div>
      </div>
    </template>

    <!-- Action buttons: primary action first, all left-aligned; dismiss is
         de-emphasized as a text-only button. -->
    <template v-if="!minimized" #foot>
      <div class="qfoot">
        <Button
          v-if="step < total - 1"
          class="qfoot-btn qfoot-main"
          size="sm"
          variant="primary"
          :disabled="!isCurrentAnswered()"
          @click="goNext"
        >{{ t('question.nextQuestion') }}</Button>
        <Button
          v-else
          class="qfoot-btn qfoot-main"
          size="sm"
          variant="primary"
          :disabled="!canSubmit()"
          :loading="submitting"
          @click="submit"
        >{{ t('question.submit') }}</Button>
        <Button
          v-if="total > 1"
          class="qfoot-btn"
          size="sm"
          variant="secondary"
          :disabled="step === 0 || busy"
          @click="goBack"
        >{{ t('question.back') }}</Button>
        <Button class="qfoot-btn" size="sm" variant="ghost" :loading="dismissing" :disabled="busy" @click="dismiss">{{ t('question.dismiss') }}</Button>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.qcard {
  margin: var(--space-2) 0;
}
/* Accent attention-card head band layered on top of the shared flat Card
   primitive (Card supplies the border, radius and surface; no shadow). */
.qcard.ui-card { border-color: var(--color-accent-bd); }
.qcard :deep(.ui-card__head) {
  background: var(--color-accent-soft);
  border-bottom-color: var(--color-accent-bd);
}
/* When minimized the body/foot slots are not rendered; collapse the (always-
   rendered) Card body and drop the head border so the card is a thin bar. */
.qcard.minimized :deep(.ui-card__body) { display: none; }
.qcard.minimized :deep(.ui-card__head) { border-bottom: none; }

/* Header — content row (Card provides the band padding/border). */
.qh {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}
.qh-ic {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-accent);
  font-weight: var(--weight-semibold);
  font-size: 15px;
  line-height: 1;
  flex: none;
}
.qtitle {
  color: var(--color-accent-hover);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}
.qstep {
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
  margin-left: var(--space-1);
}
/* Minimize toggle — pinned to the right of the header row. */
.qmin {
  margin-left: auto;
}
/* Question preview shown only while minimized — truncated to one line. */
.qmin-peek {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
}

/* Body */
.qbody {
  color: var(--color-text);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}

/* Stepper */
.qsteps {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-family: var(--font-ui);
}
.qstep-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
  cursor: pointer;
  padding: 0;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.qstep-dot:hover:not(.active) { background: var(--color-surface-sunken); }
.qstep-dot.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-weight: var(--weight-medium);
}
.qstep-dot.answered:not(.active) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.qheader-chip {
  margin-bottom: var(--space-2);
}

.qtext {
  font-size: var(--text-base);
  color: var(--color-text);
  font-weight: var(--weight-medium);
  margin-bottom: var(--space-2);
  line-height: var(--leading-normal);
}

.qmdbody { margin-bottom: var(--space-2); }

/* Options */
.qopts { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-2); }

.qopt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  cursor: pointer;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  user-select: none;
}
.qopt:hover { background: var(--color-surface-sunken); }
.qopt.selected { border-color: var(--color-accent-bd); background: var(--color-accent-soft); color: var(--color-text); }

.qopt-key {
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
  font-weight: var(--weight-medium);
  width: 12px;
  flex: none;
  text-align: center;
}
.qopt-glyph { color: var(--color-accent-hover); font-size: var(--text-base); flex: none; }
/* Label + description stack vertically (top-to-bottom) so a long description
   never squeezes the label sideways into a thin, many-line column. */
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
  font-weight: var(--weight-medium);
}

.chk, .rad { font: var(--text-base) var(--font-mono); }

.other-input {
  flex: 1;
  font: var(--text-base) var(--font-ui);
  border: none;
  border-bottom: 1px solid var(--color-line);
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

/* Footer */
.qfoot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}

/* =========================================================================
   MOBILE (≤640px): bigger option taps, comfortable nav, and full-width footer
   buttons that are ≥44px tall so Submit/Dismiss are easy to hit. The card is
   already full-width inside ConversationPane; we only resize controls.
   ========================================================================= */
@media (max-width: 640px) {
  .qh { flex-wrap: wrap; row-gap: var(--space-1); }

  .qtext { font-size: var(--text-lg); }

  /* Stepper → slightly larger tap targets. */
  .qstep-dot {
    width: 28px;
    height: 28px;
    font: var(--text-xs) var(--font-ui);
  }

  /* Options → taller, finger-friendly rows. Label + description already stack
     via .qopt-text, so no flex-wrap hack is needed. */
  .qopt {
    min-height: 44px;
    padding: var(--space-3);
    font-size: var(--text-base);
    border-radius: var(--radius-md);
  }
  .qopt-desc { font-size: var(--text-xs); }
  .other-input { flex-basis: 100%; min-height: 28px; }

  /* Footer → full-width stacked buttons, Next/Submit on top. */
  .qfoot { flex-direction: column; }
  .qfoot-btn {
    width: 100%;
    min-height: 46px;
  }
  .qfoot-main { order: -1; }
}
</style>
