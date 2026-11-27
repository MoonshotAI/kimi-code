<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UIQuestion } from '@moonshot-ai/app-core/client/types';
import type { QuestionAnswer, QuestionResponse } from '@moonshot-ai/app-core/api';
import { Markdown } from '@moonshot-ai/app-markdown';
import { Button, Icon, IconButton, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';

const props = defineProps<{
  question: UIQuestion;
  busyKind?: 'answer' | 'dismiss';
}>();

const { t } = useI18n();

const emit = defineEmits<{
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
}>();

const step = ref(0);

const minimized = ref(false);
const paneMounted = ref(!minimized.value);
const paneEl = ref<HTMLElement | null>(null);
const paneAnimating = ref(false);
let paneAnim: Animation | undefined;
let paneTimer: ReturnType<typeof setTimeout> | null = null;

function settlePane(open: boolean): void {
  const el = paneEl.value;
  if (!el) return;
  el.style.height = open ? 'auto' : '0px';
  paneAnimating.value = false;
}

function runPane(open: boolean): void {
  const el = paneEl.value;
  if (!el) return;
  if (typeof el.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settlePane(open);
    return;
  }
  paneAnim?.cancel();
  const from = el.getBoundingClientRect().height;
  el.style.height = 'auto';
  const to = open ? el.getBoundingClientRect().height : 0;
  el.style.height = `${from}px`;
  paneAnimating.value = true;
  paneAnim = el.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
  paneAnim.onfinish = () => {
    paneAnim = undefined;
    settlePane(open);
  };
}

watch(minimized, (isMin) => {
  if (paneTimer !== null) {
    clearTimeout(paneTimer);
    paneTimer = null;
  }
  if (!isMin) {
    if (paneMounted.value) {
      void nextTick(() => runPane(true));
      return;
    }
    paneMounted.value = true;
    void nextTick(() => {
      const el = paneEl.value;
      if (el) el.style.height = '0px';
      runPane(true);
    });
    return;
  }
  runPane(false);
  paneTimer = setTimeout(() => {
    paneTimer = null;
    paneMounted.value = false;
  }, 260);
});

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

const answers = ref<Record<string, QuestionAnswer>>({});

function isRecommendedOption(option: { label: string }): boolean {
  return /[(（]\s*(?:recommended|推荐)\s*[)）]\s*$/i.test(option.label);
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

function pickSingle(qid: string, optionId: string): void {
  const cur = answers.value[qid];
  if (cur && cur.kind === 'single' && cur.optionId === optionId) {
    const next = { ...answers.value };
    delete next[qid];
    answers.value = next;
  } else {
    answers.value = { ...answers.value, [qid]: { kind: 'single', optionId } };
  }
}

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

const otherTexts = ref<Record<string, string>>({});

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
  return props.question.questions.every((qi) => isQuestionAnswered(qi.id));
}

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

const highlight = ref(0);
let suppressKeyScrollFollow = false;
watch([step, () => props.question.questionId], () => {
  if (highlight.value !== 0) suppressKeyScrollFollow = true;
  highlight.value = 0;
});

const cardEl = ref<HTMLElement | null>(null);

function scrollIntoScrollport(scroller: HTMLElement, el: HTMLElement): void {
  const scrollerRect = scroller.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const top = elRect.top - scrollerRect.top + scroller.scrollTop;
  const bottom = top + elRect.height;
  if (elRect.height >= scroller.clientHeight || top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
}

function scrollKeyRowIntoView(): void {
  const card = cardEl.value;
  const body = card?.querySelector<HTMLElement>('.qbody');
  if (!card || !body) return;
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

watch(step, () => {
  void nextTick(() => {
    const body = cardEl.value?.querySelector<HTMLElement>('.qbody');
    if (body) body.scrollTop = 0;
    if (cardEl.value) cardEl.value.scrollTop = 0;
  });
});

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea';
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (busy.value) return;
  if (isComposingKeyEvent(e)) return;
  if (openDialogCount.value > 0) return;

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

  if (e.key === 'Escape') {
    if (openDialogCount.value > 0 || e.defaultPrevented) return;
    if (inField && !cardEl.value?.contains(document.activeElement)) return;
    e.preventDefault();
    dismiss();
    return;
  }
  if (inField) return;
  if (minimized.value) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const q = current.value;
    const count = q.options.length + (q.allowOther ? 1 : 0);
    if (count === 0) return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(count - 1, Math.max(0, highlight.value + delta));
    if (next === highlight.value) {
      void nextTick(scrollKeyRowIntoView);
      return;
    }
    highlight.value = next;
    const opt = q.options[highlight.value];
    if (opt) {
      if (!q.multiSelect) pickSingle(q.id, opt.id);
    } else if (q.allowOther && !q.multiSelect) {
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
      void nextTick(scrollKeyRowIntoView);
    } else if (q.allowOther && optIdx === q.options.length) {
      highlight.value = optIdx;
      selectOther(q.id);
    }
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onActivated(() => document.addEventListener('keydown', handleKeydown));
onDeactivated(() => document.removeEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div ref="cardEl" class="qcard" :class="{ minimized, animating: paneAnimating }">
    <div class="qh" :class="{ clickable: minimized }" @click="expandFromBar">
      <span class="qh-ic" aria-hidden="true"><Icon name="message" size="lg" /></span>
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

    <div v-if="paneMounted" ref="paneEl" class="qpane" :inert="minimized">
      <div class="qpane-inner">
        <div class="qbody">
          <Markdown v-if="current.body" :text="current.body" class="qmdbody" />

          <div class="qopts" :class="{ multi: current.multiSelect }">
            <label
              v-for="(opt, oi) in current.options"
              :key="opt.id"
              class="qopt"
              :class="{ selected: isSelected(current.id, opt.id), highlighted: current.multiSelect && oi === highlight }"
              @click.prevent="highlight = oi; current.multiSelect ? toggleMulti(current.id, opt.id) : pickSingle(current.id, opt.id)"
            >
              <span v-if="current.multiSelect" class="qopt-glyph"><Icon class="qopt-check" name="checkbox-checked" size="lg" /></span>
              <span class="qopt-text">
                <span class="qopt-label">{{ opt.label }}</span>
                <span v-if="opt.description" class="qopt-desc">{{ opt.description }}</span>
              </span>
              <span v-if="oi < 9" class="qopt-key">{{ oi + 1 }}</span>
            </label>

            <label
              v-if="current.allowOther"
              class="qopt qopt-other"
              :class="{ selected: isOtherSelected(current.id), highlighted: current.multiSelect && highlight === current.options.length }"
              @click.prevent="highlight = current.options.length; selectOther(current.id)"
            >
              <span v-if="current.multiSelect" class="qopt-glyph"><Icon class="qopt-check" name="checkbox-checked" size="lg" /></span>
              <span class="qopt-text qopt-text-other">
                <span class="qopt-label">{{ current.otherLabel || t('question.otherLabel') }}</span>
                <span v-if="current.otherDescription" class="qopt-desc">{{ current.otherDescription }}</span>
              </span>
              <input
                ref="otherInputEl"
                v-model="otherTexts[current.id]"
                class="other-input"
                type="text"
                :placeholder="current.otherLabel || t('question.otherPlaceholder')"
                @input="pickOther(current.id)"
                @focus="pickOther(current.id)"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
              />
              <span v-if="current.options.length < 9" class="qopt-key">{{ current.options.length + 1 }}</span>
            </label>
          </div>
        </div>

        <div class="qfoot">
          <div class="qbtns">
            <Button
              v-if="total > 1"
              class="qback"
              variant="secondary"
              :disabled="step === 0 || busy"
              @click="goBack"
            >{{ t('question.back') }}</Button>
            <Button class="qdismiss" variant="secondary" :keys="['escape']" :loading="dismissing" :disabled="busy" @click="dismiss">{{ t('question.dismiss') }}</Button>
            <Button
              v-if="step < total - 1"
              class="qmain"
              variant="primary"
              :keys="['enter']"
              :disabled="!isCurrentAnswered()"
              @click="goNext"
            >{{ t('question.nextQuestion') }}</Button>
            <Button
              v-else
              class="qmain"
              variant="primary"
              :keys="['enter']"
              :disabled="!canSubmit()"
              :loading="submitting"
              @click="submit"
            >{{ t('question.submit') }}</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qcard {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
  margin: var(--space-2) 0;
  background: var(--color-bg-translucent);
  backdrop-filter: var(--p-card-backdrop);
  -webkit-backdrop-filter: var(--p-card-backdrop);
  border: var(--p-hairline) solid var(--color-text-quaternary);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-input);
  overflow: hidden auto;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
  container-type: inline-size;
}
.qcard > .qh,
.qpane-inner > .qfoot { flex: none; }
.qpane {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
}
.qpane-inner {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.qpane-inner > .qbody { flex: 0 1 auto; }

.qcard.animating {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: var(--color-bg);
}
.qcard.animating .qpane {
  will-change: height;
}

.qcard.minimized { transition: background var(--duration-fast) var(--ease-out); }
.qcard.minimized:hover { background: var(--color-hover); }

.qh {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-3) 0;
}
.qcard.minimized .qh { padding-bottom: var(--space-3); align-items: center; }
.qcard.minimized .qh.clickable { cursor: pointer; }
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
.qh-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--color-text);
}
.qh-ic :deep(.kw-icon) {
  width: 22px;
  height: 22px;
}

.qtitle {
  flex: 1;
  min-width: 0;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.qcard.minimized .qtitle {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qmin,
.qclose {
  flex: none;
  margin-top: calc((var(--text-lg) * var(--leading-tight) - var(--icon-button-sm)) / 2);
}
.qmin { margin-left: auto; }
.qcard.minimized .qmin { margin-top: 0; }
.qcard.minimized .qclose { margin-top: 0; }

.qbody {
  min-height: min(var(--question-card-body-min-h), calc(var(--app-height, 100dvh) * 0.25));
  overflow-y: auto;
  margin-top: 10px;
  padding: 0 var(--space-3);
  color: var(--color-text);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}

.qmdbody {
  margin-bottom: var(--space-2);
  --markdown-font-family: var(--font-ui);
}

.qopts { display: flex; flex-direction: column; gap: 0; }

.qopt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  transition: background var(--duration-fast) var(--ease-out);
  user-select: none;
}

.qopt-key {
  margin-left: auto;
  align-self: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--color-fill-2);
  color: var(--color-text-muted);
  font: var(--weight-regular) var(--text-base)/22px var(--font-ui);
  text-align: center;
  flex: none;
}
.qopt-key:empty {
  background: transparent;
}

.qopt-glyph {
  width: 22px;
  height: 22px;
  flex: none;
  position: relative;
}
.qopt-glyph::before {
  content: '';
  position: absolute;
  inset: 16.67%;
  border: 1.2px solid var(--color-fill-4);
  border-radius: 3px;
}
.qopt-check {
  position: absolute;
  inset: 0;
  width: 22px;
  height: 22px;
  color: var(--color-text);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.qopt.selected .qopt-glyph::before {
  opacity: 0;
}
.qopt.selected .qopt-check {
  opacity: 1;
}

.qopts:not(.multi) .qopt.selected,
.qopts.multi .qopt.highlighted,
.qopt:hover {
  background: var(--color-fill-1);
}

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
  font-weight: var(--weight-regular);
}
.qopt-desc {
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}

.qopt-text-other { flex: 0 1 auto; }

.other-input {
  flex: 1;
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  outline: none;
  padding: 6px;
  color: var(--color-text);
  background: transparent;
  min-width: 12ch;
}
.other-input::placeholder {
  color: var(--color-text-muted);
}
.other-input:focus {
  border-color: var(--color-line-strong);
}

.qfoot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: 10px;
  padding: 0 var(--space-3) var(--space-3);
}
.qbtns {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 640px) {
  .qcard {
    margin-inline: max(12px, var(--safe-left)) max(12px, var(--safe-right));
  }
}
@media (pointer: coarse) {
  .qopt-key,
  .qbtns :deep(.ui-button__cap) {
    display: none;
  }
}
@container (max-width: 640px) {
  .qopt {
    min-height: 44px;
    padding: var(--space-3);
  }
  .qopt-other { flex-wrap: wrap; }
  .qopt-other .qopt-text-other { flex: 1; }
  .other-input {
    order: 4;
    flex: 1 0 100%;
    width: 100%;
    min-width: 0;
    min-height: 36px;
    margin-top: var(--space-2);
  }

}
@media (pointer: coarse) {
  @container (max-width: 640px) {
    .qfoot { flex-direction: column; align-items: stretch; }
    .qbtns {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      width: 100%;
    }
    .qbtns > :deep(.ui-button) {
      width: 100%;
      min-width: 0;
      min-height: 46px;
      justify-content: center;
      white-space: normal;
    }
    .qbtns .qmain {
      order: -1;
      grid-column: 1 / -1;
    }
    .qbtns > :deep(.qback:disabled) { display: none; }
    .qbtns > :deep(.qdismiss:first-child),
    .qbtns > :deep(.qback:disabled + .qdismiss) {
      grid-column: 1 / -1;
    }
  }
}
</style>
