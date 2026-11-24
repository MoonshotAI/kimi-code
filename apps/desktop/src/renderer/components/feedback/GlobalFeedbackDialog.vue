<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFontPrefs } from '@moonshot-ai/app-core';
import { Button, Checkbox, Dialog, IconButton, Pill, Textarea } from '@moonshot-ai/app-ui';
import { canCollectFeedbackDiagnostics } from '../../lib/feedbackDiagnostics';
import {
  DesktopFeedbackKey,
  FEEDBACK_DESCRIPTION_LIMIT,
  feedbackAccessFailureKey,
  type FeedbackAttachment,
  type FeedbackForm,
  type GlobalFeedbackTarget,
} from '../../composables/useDesktopFeedback';
import FeedbackGuideLink from './FeedbackGuideLink.vue';
import GlobalFeedbackMedia from './GlobalFeedbackMedia.vue';
import { addFeedbackMedia, FEEDBACK_MEDIA_LIMIT, type FeedbackMedia } from './feedbackMedia';

const props = defineProps<{ target: GlobalFeedbackTarget | null; supportsSessionUpload: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();
const { fontPrefs } = useFontPrefs();
const feedback = inject(DesktopFeedbackKey);
const descriptionId = useId();
const categories = ['bug', 'suggestion', 'other'] as const;
const canIncludeDiagnostics = canCollectFeedbackDiagnostics();

interface FeedbackDraft {
  sessionId?: string;
  uploadSessionId?: string;
  category: (typeof categories)[number];
  description: string;
  media: FeedbackMedia[];
  includeDiagnostics: boolean;
}

type Submission = { kind: 'editing' | 'submitting' } | { kind: 'failed'; messageKey: string };

function blankDraft(sessionId?: string): FeedbackDraft {
  return { sessionId, category: 'bug', description: '', media: [], includeDiagnostics: false };
}

const draft = ref(blankDraft());
const guideUrls = shallowRef<FeedbackForm['learn_more_url']>();
const availableSessionId = computed(() => props.supportsSessionUpload ? props.target?.sessionId : undefined);
const hasDraft = computed(() => draft.value.category !== 'bug' || draft.value.description.length > 0
  || draft.value.media.length > 0 || draft.value.includeDiagnostics || draft.value.uploadSessionId !== undefined);
const overLimit = computed(() => draft.value.description.length > FEEDBACK_DESCRIPTION_LIMIT);
const submission = ref<Submission>({ kind: 'editing' });
const busy = computed(() => submission.value.kind === 'submitting');
const dragDepth = ref(0);
const mediaErrors = ref<string[]>([]);
let errorTimer: ReturnType<typeof setTimeout> | undefined;

function resetMediaErrors(): void {
  clearTimeout(errorTimer);
  mediaErrors.value = [];
}

function clearDraft(): void {
  for (const item of draft.value.media) URL.revokeObjectURL(item.url);
  draft.value = blankDraft();
}

onBeforeUnmount(() => {
  resetMediaErrors();
  clearDraft();
});

watch([() => props.target, availableSessionId], ([target, sessionId], [previousTarget]) => {
  if (target !== null && draft.value.uploadSessionId !== sessionId) draft.value.uploadSessionId = undefined;
  if (target === previousTarget) return;
  guideUrls.value = undefined;
  if (target !== null) {
    if (!hasDraft.value) draft.value = blankDraft(target.sessionId);
    guideUrls.value = feedback?.peekForm()?.learn_more_url;
    void feedback?.loadForm().then(config => {
      if (target === props.target && config !== null) guideUrls.value = config.learn_more_url;
    });
  }
  dragDepth.value = 0;
  resetMediaErrors();
  submission.value = { kind: 'editing' };
}, { immediate: true });

function addMedia(files: FileList): void {
  if (busy.value) return;
  resetMediaErrors();
  mediaErrors.value = addFeedbackMedia(draft.value.media, files);
  if (mediaErrors.value.length) errorTimer = setTimeout(resetMediaErrors, 6000);
}

function removeMedia(item: FeedbackMedia): void {
  if (busy.value) return;
  draft.value.media = draft.value.media.filter(current => current.url !== item.url);
  URL.revokeObjectURL(item.url);
  resetMediaErrors();
}

function pasteMedia(event: ClipboardEvent): void {
  const files = event.clipboardData?.files;
  if (!files?.length) return;
  event.preventDefault();
  event.stopPropagation();
  addMedia(files);
}

function dragFile(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.stopPropagation();
  if (busy.value) {
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  if (event.type === 'drop') {
    dragDepth.value = 0;
    addMedia(event.dataTransfer.files);
  } else if (event.type === 'dragleave') {
    dragDepth.value = Math.max(0, dragDepth.value - 1);
  } else if (event.type === 'dragenter') {
    dragDepth.value += 1;
  } else {
    event.dataTransfer.dropEffect = 'copy';
    dragDepth.value = Math.max(1, dragDepth.value);
  }
}

function close(): void {
  if (!busy.value) emit('close');
}

async function submit(): Promise<void> {
  const editing = draft.value;
  const target = props.target;
  const content = editing.description.trim();
  if (!target || busy.value || !content || overLimit.value || !feedback?.requireLogin()) return;
  const uploadSessionId = editing.uploadSessionId === availableSessionId.value ? editing.uploadSessionId : undefined;
  const attachments = editing.media.map<FeedbackAttachment>(({ file }) => ({ kind: 'media', file }));
  if (uploadSessionId !== undefined) attachments.push({ kind: 'session', sessionId: uploadSessionId });
  if (editing.includeDiagnostics) attachments.push({ kind: 'diagnostics' });
  resetMediaErrors();
  submission.value = { kind: 'submitting' };
  try {
    const id = await feedback.submitGlobal({
      kind: 'global',
      source: target.source,
      category: editing.category,
      content,
      session_id: uploadSessionId ?? editing.sessionId,
    }, attachments);
    if (draft.value !== editing) return;
    submission.value = { kind: 'editing' };
    if (id !== undefined) {
      clearDraft();
      emit('close');
    }
  } catch (error) {
    if (draft.value === editing) submission.value = { kind: 'failed', messageKey: feedbackAccessFailureKey(error) ?? 'feedback.globalSubmitFailed' };
  }
}
</script>

<template>
  <Dialog
    :open="target !== null"
    :aria-label="t('feedback.send')"
    panel-class="global-feedback-dialog"
    initial-focus=".global-feedback-form"
    :close-on-overlay="!busy"
    :close-on-esc="!busy"
    :padded="false"
    @close="close"
  >
    <form
      class="global-feedback-form"
      :class="{ 'global-feedback-default-font': fontPrefs.ui.mode === 'kimi' }"
      :lang="locale"
      tabindex="-1"
      @paste="pasteMedia"
      @dragenter="dragFile"
      @dragover="dragFile"
      @dragleave="dragFile"
      @drop="dragFile"
      @submit.prevent="submit"
    >
      <header class="global-feedback-head">
        <h2>{{ t('feedback.send') }}</h2>
        <IconButton class="global-feedback-close" :label="t('common.close')" :disabled="busy" @click="close">
          <span aria-hidden="true" />
        </IconButton>
      </header>
      <div class="global-feedback-fields">
        <div class="global-feedback-categories" role="group" :aria-label="t('feedback.category')">
          <Pill
            v-for="item in categories"
            :key="item"
            :active="draft.category === item"
            :aria-pressed="draft.category === item"
            :disabled="busy"
            @click="draft.category = item"
          >{{ t('feedback.categories.' + item) }}</Pill>
        </div>
        <div class="global-feedback-description">
          <div class="global-feedback-label">
            <label :for="descriptionId">{{ t('feedback.description') }}<span aria-hidden="true">*</span></label>
            <span class="global-feedback-count" :class="{ 'is-over': overLimit }">{{ draft.description.length.toLocaleString(locale) }} / {{ FEEDBACK_DESCRIPTION_LIMIT }}</span>
          </div>
          <Textarea
            :id="descriptionId"
            v-model="draft.description"
            :aria-invalid="overLimit || undefined"
            :placeholder="t('feedback.placeholders.' + draft.category)"
            :resize="false"
            :disabled="busy"
            required
          />
        </div>
        <GlobalFeedbackMedia
          :items="draft.media"
          :errors="mediaErrors"
          :disabled="busy"
          @add="addMedia"
          @remove="removeMedia"
        />
        <div class="global-feedback-upload">
          <div v-if="availableSessionId !== undefined || canIncludeDiagnostics" class="global-feedback-options">
            <Checkbox
              v-if="availableSessionId !== undefined"
              :model-value="draft.uploadSessionId === availableSessionId"
              :disabled="busy"
              @update:model-value="draft.uploadSessionId = $event ? availableSessionId : undefined"
            >{{ t('feedback.includeSession') }}</Checkbox>
            <Checkbox v-if="canIncludeDiagnostics" v-model="draft.includeDiagnostics" :disabled="busy">{{ t('feedback.includeDiagnostics') }}</Checkbox>
          </div>
          <p class="global-feedback-note">{{ t('feedback.dataUse') }} <FeedbackGuideLink :urls="guideUrls" /></p>
        </div>
      </div>
      <footer class="global-feedback-footer">
        <div class="global-feedback-buttons">
          <span v-if="submission.kind === 'failed'" class="global-feedback-error" role="alert">
            {{ t(submission.messageKey) }}
          </span>
          <Button variant="secondary" :disabled="busy" @click="close">{{ t('common.cancel') }}</Button>
          <Button
            type="submit"
            :aria-label="busy ? t('feedback.submittingGlobal') : undefined"
            :loading="busy"
            :disabled="!draft.description.trim() || overLimit"
          >
            <span v-if="!busy">{{ t(submission.kind === 'failed' ? 'feedback.resubmit' : 'feedback.submitGlobal') }}</span>
          </Button>
        </div>
      </footer>
      <div
        v-if="dragDepth > 0"
        class="global-feedback-drag"
        :class="{ 'is-full': draft.media.length >= FEEDBACK_MEDIA_LIMIT }"
        role="status"
      >
        <svg class="global-feedback-drag-border" aria-hidden="true"><rect x=".75" y=".75" rx="11.25" /></svg>
        <span class="global-feedback-drag-icon" aria-hidden="true" />
        <strong>{{ t(draft.media.length >= FEEDBACK_MEDIA_LIMIT ? 'feedback.mediaCount' : 'feedback.dropTitle') }}</strong>
        <span>{{ t(draft.media.length >= FEEDBACK_MEDIA_LIMIT ? 'feedback.dropFull' : 'feedback.dropHint') }}</span>
      </div>
    </form>
  </Dialog>
</template>

<style src="./global-feedback.css"></style>
