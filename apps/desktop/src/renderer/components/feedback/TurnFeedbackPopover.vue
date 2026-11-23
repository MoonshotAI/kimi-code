<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFontPrefs, useIsDark } from '@moonshot-ai/app-core';
import { Button, Checkbox, IconButton, Menu, Pill, Skeleton, Textarea } from '@moonshot-ai/app-ui';
import { DesktopFeedbackKey, FEEDBACK_DESCRIPTION_LIMIT, type FeedbackForm, type TurnFeedbackTarget } from '../../composables/useDesktopFeedback';
import FeedbackGuideLink from './FeedbackGuideLink.vue';

const props = defineProps<{
  anchor: HTMLButtonElement;
  target: TurnFeedbackTarget;
  saving: boolean;
  updating: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();
const { fontPrefs } = useFontPrefs();
const isDark = useIsDark();
const feedback = inject(DesktopFeedbackKey);
const menu = ref<InstanceType<typeof Menu>>();
const editor = ref<InstanceType<typeof Textarea>>();
const scrolls = ref(false);
const deferPreview = ref(false);
const position = shallowRef<{ top: number; left: number; maxHeight: number }>();
const form = shallowRef<FeedbackForm | null | undefined>(feedback?.peekForm(props.target.sessionId));
const builtinReasons = ['incorrect', 'missed_instructions', 'off_topic', 'lost_context', 'slow', 'other'] as const;
const reasonOptions = computed(() => {
  if (form.value === undefined) return [];
  if (form.value === null) return builtinReasons.map(id => ({ id, label: t(`feedback.reasons.${id}`) }));
  return form.value.reply_reasons.negative.map(reason => ({
    id: reason.id,
    label: locale.value.startsWith('zh') ? reason.label.zh : reason.label.en,
  }));
});
const selected = ref<string[]>([]);
const detail = ref('');
const includeSession = ref(false);
const retry = ref(false);
const countId = useId();
const overLimit = computed(() => detail.value.length > FEEDBACK_DESCRIPTION_LIMIT);
const canSubmit = computed(() => selected.value.length > 0 && !overLimit.value && !props.saving && !props.updating);
let observer: ResizeObserver | undefined;
let active = true;

function measure(): void {
  const panel = menu.value?.el;
  if (!panel) return;
  const input = editor.value?.el;
  if (input) scrolls.value = input.scrollHeight > Number.parseFloat(getComputedStyle(input).maxHeight);
  const anchor = props.anchor.getBoundingClientRect();
  const margin = 8;
  const belowTop = Math.max(margin, anchor.bottom + margin);
  const aboveBottom = Math.min(window.innerHeight - margin, anchor.top - margin);
  const below = window.innerHeight - margin - belowTop;
  const above = aboveBottom - margin;
  const height = panel.scrollHeight;
  const opensBelow = height <= below || (height > above && below >= above);
  const maxHeight = Math.max(1, opensBelow ? below : above);
  position.value = {
    left: Math.max(margin, Math.min(anchor.left - margin, window.innerWidth - panel.offsetWidth - margin)),
    top: opensBelow ? belowTop : aboveBottom - Math.min(height, maxHeight),
    maxHeight,
  };
}

function outside(event: Event): void {
  const panel = menu.value?.el;
  const path = event.composedPath();
  if (!panel || path.includes(panel) || path.includes(props.anchor)) return;
  if (path.some(node => node instanceof HTMLElement && node.hasAttribute('data-kimi-toast-host'))) return;
  emit('close');
}

function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  emit('close');
}

watch(form, measure, { flush: 'post' });

onMounted(() => {
  const panel = menu.value?.el;
  if (!panel) return;
  measure();
  void nextTick(() => menu.value?.el?.focus({ preventScroll: true }));
  observer = new ResizeObserver(measure);
  observer.observe(panel);
  observer.observe(props.anchor);
  if (editor.value?.el) observer.observe(editor.value.el);
  document.addEventListener('click', outside, true);
  document.addEventListener('scroll', measure, true);
  window.addEventListener('keydown', escape, true);
  window.addEventListener('resize', measure);
  const request = feedback?.loadForm(props.target.sessionId);
  void request?.then(config => {
    if (active && (config !== null || form.value === undefined)) form.value = config;
  });
});

onBeforeUnmount(() => {
  active = false;
  observer?.disconnect();
  document.removeEventListener('click', outside, true);
  document.removeEventListener('scroll', measure, true);
  window.removeEventListener('keydown', escape, true);
  window.removeEventListener('resize', measure);
  if (menu.value?.el?.contains(document.activeElement) && !props.anchor.disabled) props.anchor.focus({ preventScroll: true });
});

function focusEditor(event: MouseEvent): void {
  const input = editor.value?.el;
  if (!input || event.target === input || props.updating) return;
  event.preventDefault();
  input.focus();
}

function toggle(id: string): void {
  selected.value = selected.value.includes(id) ? selected.value.filter(selectedId => selectedId !== id) : [...selected.value, id];
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !feedback) return;
  retry.value = false;
  const error = await feedback.submitDetails(props.target, {
    reasons: selected.value,
    content: detail.value,
    includeSession: includeSession.value,
  });
  retry.value = error !== undefined;
}
</script>

<template>
  <Menu
    ref="menu"
    role="dialog"
    class="feedback-popover"
    :class="{ 'feedback-default-font': fontPrefs.ui.mode === 'kimi', 'feedback-popover-light': !isDark }"
    tabindex="-1"
    :aria-label="t('feedback.detailTitle')"
    :style="position ? { top: `${position.top}px`, left: `${position.left}px`, maxHeight: `${position.maxHeight}px` } : { visibility: 'hidden' }"
    @pointerdown.capture="deferPreview = overLimit && !!editor?.el?.matches(':focus')"
    @pointerup="deferPreview = false"
    @pointercancel="deferPreview = false"
    @pointerleave="deferPreview = false"
  >
    <div class="feedback-popover-header">
      <strong :class="{ 'text-ui-t2': !isDark }">{{ t('feedback.detailTitle') }}</strong>
      <span>{{ t('feedback.multipleReasons') }}</span>
      <IconButton size="sm" :label="t('common.close')" @click="emit('close')"><span class="feedback-close-glyph" aria-hidden="true" /></IconButton>
    </div>
    <div
      class="feedback-reasons"
      role="group"
      :aria-label="t('feedback.multipleReasons')"
      :aria-busy="form === undefined || undefined"
    >
      <Skeleton v-if="form === undefined" width="8em" height="var(--feedback-reason-height)" />
      <Pill
        v-for="reason in reasonOptions"
        :key="reason.id"
        :active="selected.includes(reason.id)"
        :aria-pressed="selected.includes(reason.id)"
        :disabled="updating"
        @click="toggle(reason.id)"
      ><span>{{ reason.label }}</span></Pill>
    </div>
    <div
      class="feedback-editor"
      :class="{ 'is-scrollable': scrolls, 'defer-preview': deferPreview }"
      @mousedown="focusEditor"
    >
      <Textarea
        ref="editor"
        v-model="detail"
        :aria-label="t('feedback.detail')"
        :aria-invalid="overLimit"
        :aria-describedby="countId"
        :placeholder="t('feedback.detailPlaceholder')"
        :rows="1"
        :disabled="updating"
        autosize
        @input="measure"
      />
      <span :id="countId" class="feedback-count" :class="{ 'is-over': overLimit }">{{ detail.length.toLocaleString(locale) }} / {{ FEEDBACK_DESCRIPTION_LIMIT }}</span>
    </div>
    <div class="feedback-popover-footer">
      <div class="feedback-consent">
        <Checkbox v-model="includeSession" :disabled="updating">{{ t('feedback.uploadConversation') }}</Checkbox>
        <FeedbackGuideLink :urls="form?.learn_more_url" icon-only />
      </div>
      <Button
        size="sm"
        :loading="updating"
        :disabled="!canSubmit"
        :aria-label="t(retry ? 'feedback.resubmitDetails' : 'feedback.submitDetails')"
        @click="submit"
      ><span v-if="!updating">{{ t(retry ? 'feedback.resubmitDetails' : 'feedback.submitDetails') }}</span></Button>
    </div>
  </Menu>
</template>

<style scoped>
.feedback-popover.ui-menu {
  --color-text: var(--color-send-bg);
  --color-text-muted: light-dark(rgb(0 0 0 / 60%), rgb(255 255 255 / 56%));
  --color-text-faint: light-dark(rgb(0 0 0 / 45%), rgb(255 255 255 / 42%));
  position: fixed;
  z-index: var(--z-dropdown);
  gap: var(--space-3);
  width: min(400px, calc(100vw - 16px));
  min-width: 0;
  padding: 16.5px;
  overflow: hidden auto;
  overscroll-behavior: contain;
  border: 0;
  border-radius: var(--radius-lg);
  outline: none;
  background: var(--color-surface-raised);
  box-shadow: inset 0 0 0 0.5px light-dark(rgb(0 0 0 / 13%), rgb(255 255 255 / 12%)), 0 4px 30px rgb(0 0 0 / 10%);
  backdrop-filter: none;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
  line-height: calc(var(--ui-b2) + 6px);
}
.feedback-popover.feedback-default-font { font-family: 'PingFang SC', var(--font-ui); }
.feedback-popover.feedback-popover-light { gap: var(--space-4); }
.feedback-popover > * { flex-shrink: 0; }
.feedback-popover-header, .feedback-popover-footer, .feedback-consent {
  display: flex;
  align-items: center;
}
.feedback-popover-header { gap: 6px; }
.feedback-popover-header strong { font-weight: var(--weight-medium); }
.feedback-popover-header > span {
  flex: 1;
  color: var(--color-text-faint);
  font-size: var(--ui-c1);
  line-height: 1.5;
}
.feedback-popover-header .ui-icon-button {
  width: 24px;
  height: 24px;
  color: var(--color-text-faint);
  border: 0;
}
.feedback-close-glyph {
  width: 16px;
  height: 16px;
  background: currentColor;
  mask: url('./assets/dialog-close.svg') center / contain no-repeat;
}
.feedback-reasons {
  --feedback-reason-height: calc(1lh + 12px);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.feedback-reasons .ui-pill {
  --feedback-control-bg: var(--color-fill-1);
  --feedback-control-radius: var(--radius-md);
  max-width: 100%;
  padding: 6px 10px;
  height: auto;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font: inherit;
}
.feedback-reasons .ui-pill > span { overflow: hidden; text-overflow: ellipsis; }
.feedback-reasons .ui-pill:not(.is-active):hover:enabled { --feedback-control-bg: var(--color-fill-2); background: transparent; }
.feedback-reasons .ui-pill.is-active,
.feedback-reasons .ui-pill.is-active:hover {
  --feedback-control-bg: color-mix(in srgb, var(--color-accent) 10%, transparent);
  background: transparent;
  color: var(--color-accent);
}
.feedback-reasons .ui-pill:disabled, .feedback-consent .ui-check.is-disabled { opacity: 1; }
.feedback-editor {
  --feedback-control-bg: var(--color-fill-1);
  --feedback-control-radius: var(--radius-dock-pill);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--space-1);
  width: calc(100% + 1px);
  min-height: 96px;
  padding: 10px 12px 8px;
  border-radius: var(--radius-dock-pill);
  outline: 1px solid transparent;
  outline-offset: -1px;
  cursor: text;
}
.feedback-editor:has(.ui-textarea:disabled) { cursor: default; }
.feedback-editor.is-scrollable { gap: var(--space-2); }
.feedback-editor:focus-within { outline-color: var(--color-accent); }
.feedback-editor .ui-textarea {
  min-height: 20px;
  max-height: calc(240px - 26px - 1.5 * var(--ui-c1));
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--color-text);
  font: inherit;
}
.feedback-editor .ui-textarea::placeholder { color: var(--color-text-quaternary); }
.feedback-editor:not(.defer-preview) .ui-textarea[aria-invalid="true"]:not(:focus) {
  max-height: 1lh;
  overflow: clip;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feedback-editor .ui-textarea:disabled { opacity: 1; }
.feedback-count {
  color: var(--color-text-quaternary);
  font-size: var(--ui-c1);
  line-height: 1.5;
  user-select: none;
}
.feedback-count.is-over { color: #ff3849; }
.feedback-popover-footer { justify-content: space-between; gap: var(--space-2); }
.feedback-consent { min-width: 0; gap: 6px; }
.feedback-consent .ui-check { min-width: 0; gap: 6px; }
.feedback-consent :deep(.ui-check__box) {
  --ui-check-background: transparent;
  position: relative;
  width: 16px;
  height: 16px;
  border: 0;
}
.feedback-consent :deep(.ui-check__box::before) {
  position: absolute;
  inset: 0;
  background: var(--color-fill-4);
  mask: url('./assets/unchecked-option.svg') center / contain no-repeat;
  content: '';
}
.feedback-consent :deep(.is-on .ui-check__box::before) {
  background: var(--color-accent);
  mask-image: url('./assets/checked-option.svg');
}
.feedback-consent :deep(.ui-check__box svg) { display: none; }
.feedback-consent :deep(.ui-check__label) {
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--ui-c1);
  line-height: 1.5;
}
.feedback-popover-footer .ui-button {
  --feedback-control-bg: var(--color-text);
  --feedback-control-radius: var(--radius-dock-pill);
  flex: none;
  min-width: 62px;
  height: 32px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-dock-pill);
  background: transparent;
  box-shadow: none;
  color: var(--color-bg);
  font: inherit;
  font-weight: var(--weight-medium);
}
.feedback-popover-footer .ui-button:disabled:not(.is-loading) {
  --feedback-control-bg: color-mix(in srgb, var(--color-text-strong) 15%, transparent);
  background: transparent;
  color: var(--color-text-quaternary);
  opacity: 1;
}
.feedback-popover-footer .ui-button:enabled:hover { --feedback-control-bg: var(--color-send-bg-hover); background: transparent; }
.feedback-reasons .ui-pill, .feedback-editor, .feedback-popover-footer .ui-button {
  position: relative;
  isolation: isolate;
}
.feedback-reasons .ui-pill::before, .feedback-editor::before, .feedback-popover-footer .ui-button::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: -.5px;
  clip-path: inset(.5px round var(--feedback-control-radius));
  background: var(--feedback-control-bg);
  pointer-events: none;
}
.feedback-popover-footer .ui-button.is-loading { gap: 0; opacity: 1; }
.feedback-popover-footer :deep(.ui-button.is-loading .ui-button__content) { display: none; }
</style>
