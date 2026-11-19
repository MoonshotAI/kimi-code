<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Checkbox, Dialog, Textarea } from '@moonshot-ai/app-ui';
import { browserCaptureTime } from '@moonshot-ai/app-composer/features/browser-reference';
import type { BrowserReferenceDetailsState } from './browserReferenceDetails';
import type { BrowserReferenceEditResult } from './browserReferences';

const props = defineProps<{ state: BrowserReferenceDetailsState | null }>();
const emit = defineEmits<{ resolve: [id: number, result: BrowserReferenceEditResult | null] }>();
const { t } = useI18n();
const comment = ref('');
const includeScreenshot = ref(true);
watch(() => props.state, (state) => { comment.value = state?.reference.comment ?? ''; includeScreenshot.value = state?.capture.target.kind === 'region' || state?.reference.includeScreenshot !== false; }, { immediate: true });
const screenshotStatus = computed(() => {
  if (props.state?.readOnly || props.state?.screenshotState === undefined) return '';
  if (props.state.screenshotState === 'uploading') return t('browserReference.screenshotUploading');
  return t(props.state.canRetry ? 'browserReference.screenshotFailed' : 'browserReference.screenshotUnavailable');
});

function close(): void {
  if (props.state !== null) emit('resolve', props.state.id, null);
}

function save(retryScreenshot = false): void {
  const state = props.state;
  if (state === null || state.readOnly || comment.value.length > 10_000) return;
  emit('resolve', state.id, { comment: comment.value, locate: false, retryScreenshot, includeScreenshot: state.capture.target.kind === 'region' || includeScreenshot.value });
}
</script>

<template>
  <Dialog v-if="state" :open="true" :title="state.capture.label" size="md" :initial-focus="state.readOnly ? 'button' : 'textarea'" @close="close">
    <form class="browser-reference-details" @submit.prevent="save()" @keydown.meta.enter.prevent="save()" @keydown.ctrl.enter.prevent="save()">
      <p v-if="screenshotStatus" class="browser-reference-details__status" role="status">{{ screenshotStatus }}</p>
      <div class="browser-reference-details__source">
        <time :datetime="state.capture.capturedAt">{{ t('browserReference.capturedAt', { time: browserCaptureTime(state.capture.capturedAt) }) }}</time>
        <span>{{ state.capture.page.title }}</span>
        <a :href="state.capture.page.url" target="_blank" rel="noopener noreferrer">{{ state.capture.page.url }}</a>
      </div>
      <img v-if="state.thumbnail" class="browser-reference-details__preview" :src="state.thumbnail" :alt="state.capture.label" />
      <Checkbox v-if="state.capture.screenshot" v-model="includeScreenshot" :disabled="state.readOnly || state.capture.target.kind === 'region'">{{ t(state.capture.target.kind === 'region' ? 'browserReference.regionScreenshot' : 'browserReference.includeScreenshot') }}</Checkbox>
      <label class="browser-reference-details__comment">
        <span>{{ t('browserReference.comment') }}</span>
        <Textarea v-model="comment" :readonly="state.readOnly" :placeholder="t('browserReference.commentPlaceholder')" :maxlength="10_000" />
      </label>
    </form>
    <template #foot>
      <Button v-if="!state.readOnly && state.canRetry && state.screenshotState === 'failed'" variant="ghost" @click="save(true)">{{ t('browserReference.retryScreenshot') }}</Button>
      <Button variant="secondary" @click="close">{{ t(state.readOnly ? 'common.close' : 'common.cancel') }}</Button>
      <Button v-if="!state.readOnly" :disabled="comment.length > 10_000" @click="save()">{{ t('browserReference.save') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.browser-reference-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.browser-reference-details__source,
.browser-reference-details__comment {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--ui-b2);
}
.browser-reference-details__source {
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.browser-reference-details__source a { color: inherit; }
.browser-reference-details__source time { font-variant-numeric: tabular-nums; }
.browser-reference-details__status {
  margin: 0;
  color: var(--color-warning);
  font-size: var(--ui-b2);
}
.browser-reference-details__preview {
  max-width: 100%;
  max-height: var(--browser-annotation-preview-max-height);
  width: auto;
  align-self: center;
  object-fit: contain;
  border-radius: var(--radius-xs);
}
</style>
