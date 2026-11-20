<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useToastTimer } from '@moonshot-ai/app-ui';
import type { FeedbackNotice } from '../../lib/feedbackReceipt';
import successIcon from './assets/receipt-success.svg';
import errorIcon from './assets/receipt-error.svg';

const props = defineProps<{
  notice: FeedbackNotice;
  signal: AbortSignal;
  dismiss: () => void;
}>();
const { t } = useI18n();
const copied = ref(false);
const hovered = ref(false);
const focused = ref(false);
const close = () => props.dismiss();
const timer = useToastTimer({ duration: () => 6000, onExpire: close });
const busy = computed(() => props.notice.kind === 'retrying');
const error = computed(() => props.notice.kind === 'upload' || props.notice.kind === 'error');
const message = computed(() => {
  const notice = props.notice;
  if (notice.kind === 'submitted') return t('feedback.submittedId', { id: notice.feedbackId });
  if (notice.kind === 'error') return t(notice.message);
  if (notice.kind === 'retrying') return t('feedback.uploading');
  const files = notice.kind === 'uploaded' ? notice.files : notice.failed;
  const names = files.map(item => item.kind === 'media'
    ? item.file.name
    : t(item.kind === 'session' ? 'feedback.sessionFile' : 'feedback.diagnosticsFile'));
  return t(notice.kind === 'uploaded' ? 'feedback.uploadComplete' : 'feedback.uploadFailed', { names: names.join(t('feedback.fileSeparator')) });
});

function syncTimer(): void {
  if (hovered.value || focused.value || busy.value) timer.pause();
  else timer.resume();
}
watch(() => props.notice, () => {
  timer.restart();
  syncTimer();
});
watch([hovered, focused], syncTimer);

async function copyId(): Promise<void> {
  if (props.notice.kind === 'submitted') copied.value = await copyTextToClipboard(String(props.notice.feedbackId));
}
onMounted(() => {
  if (props.signal.aborted) close();
  else props.signal.addEventListener('abort', close, { once: true });
});
onBeforeUnmount(() => props.signal.removeEventListener('abort', close));
</script>

<template>
  <div
    class="feedback-toast"
    :class="{
      'feedback-receipt-toast': notice.kind === 'submitted',
      'feedback-upload-toast': notice.kind === 'upload',
      'feedback-upload-progress': busy,
      'feedback-upload-complete': notice.kind === 'uploaded',
    }"
    :role="error ? 'alert' : 'status'"
    @pointerenter="hovered = true" @pointerleave="hovered = false"
    @focusin="focused = true" @focusout="focused = false"
  >
    <span v-if="busy" class="feedback-progress-icon" aria-hidden="true" />
    <img v-else :src="error ? errorIcon : successIcon" alt="" width="20" height="20">
    <span>{{ message }}</span>
    <button
      v-if="notice.kind === 'submitted'" type="button"
      :aria-label="t(copied ? 'feedback.copied' : 'feedback.copyId')" @click="copyId"
    >{{ t(copied ? 'feedback.copied' : 'feedback.copyIdShort') }}</button>
    <button v-else-if="notice.kind === 'upload'" type="button" @click="notice.retry">
      {{ t('feedback.retryUpload') }}
    </button>
  </div>
</template>

<style scoped>
.feedback-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: max-content;
  max-width: calc(100vw - 32px);
  min-height: 40px;
  padding: 0 12px;
  border-radius: 12px;
  color: white;
  background: light-dark(#2b2b2b, #404040);
  font: 400 14px/20px "PingFang SC", var(--font-ui);
}
.feedback-toast > img { flex: none; }
.feedback-toast > span:not(.feedback-progress-icon) { min-width: 0; padding: 10px 8px; overflow-wrap: anywhere; }
.feedback-progress-icon {
  flex: none; width: 20px; height: 20px;
  background: url('./assets/uploading.png') center / 16.667px 16.667px no-repeat;
  animation: feedback-progress 1s linear infinite;
}
@keyframes feedback-progress { from { transform: scaleX(-1) rotate(0); } to { transform: scaleX(-1) rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .feedback-progress-icon { animation: none; transform: scaleX(-1); } }
.feedback-upload-progress, .feedback-upload-complete { padding-right: 16px; }
.feedback-upload-progress > span:last-child, .feedback-upload-complete > span:last-child { padding-right: 0; }
.feedback-receipt-toast { width: 360px; }
.feedback-receipt-toast > span { flex: 1; text-align: center; }
.feedback-toast > button {
  flex: none;
  appearance: none;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 4px;
  color: #1a88ff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
</style>
