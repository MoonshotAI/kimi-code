<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconButton } from '@moonshot-ai/app-ui';
import { FEEDBACK_MEDIA_LIMIT, type FeedbackMedia } from './feedbackMedia';

defineProps<{ items: FeedbackMedia[]; disabled: boolean; errors: string[] }>();
const emit = defineEmits<{ add: [files: FileList]; remove: [item: FeedbackMedia] }>();
const { t } = useI18n();
const picker = ref<HTMLInputElement>();
const loadedVideo = ref<{ url: string; duration: string }>();

function pick(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.files === null) return;
  emit('add', input.files);
  input.value = '';
}

function readDuration(event: Event, url: string): void {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement) || !Number.isFinite(video.duration)) return;
  const seconds = Math.floor(video.duration);
  const time = [Math.floor(seconds / 60), seconds % 60].map(part => String(part).padStart(2, '0'));
  loadedVideo.value = { url, duration: time.join(':') };
}
</script>

<template>
  <div class="global-feedback-media">
    <input ref="picker" type="file" accept="image/*,video/*" multiple hidden :disabled="disabled" @change="pick" />
    <div class="global-feedback-rail">
      <div v-for="item in items" :key="item.url" class="global-feedback-preview">
        <img v-if="item.kind === 'image'" class="global-feedback-photo" :src="item.url" :alt="item.file.name" draggable="false" />
        <template v-else>
          <video :src="item.url" :aria-label="item.file.name" preload="metadata" muted playsinline @loadedmetadata="readDuration($event, item.url)" />
          <img class="global-feedback-play" src="./assets/play-media.svg" alt="" />
          <span v-if="loadedVideo?.url === item.url" class="global-feedback-duration">{{ loadedVideo.duration }}</span>
        </template>
        <IconButton
          class="global-feedback-remove"
          :label="t('feedback.removeMedia', { name: item.file.name })"
          :disabled="disabled"
          @click="$emit('remove', item)"
        >
          <img src="./assets/remove-media.svg" alt="" />
        </IconButton>
      </div>
      <button v-if="items.length < FEEDBACK_MEDIA_LIMIT" class="global-feedback-add" type="button" :disabled="disabled" @click="picker?.click()">
        <svg class="global-feedback-add-border" aria-hidden="true"><rect x=".5" y=".5" rx="7.5" /></svg>
        <span aria-hidden="true" />
        {{ t('feedback.addMedia') }}
      </button>
    </div>
    <div v-if="errors.length" class="global-feedback-media-errors" role="alert">
      <span v-for="key in errors" :key="key" class="global-feedback-error">{{ t(key) }}</span>
    </div>
    <p v-else class="global-feedback-media-hint">{{ t('feedback.mediaHint') }}</p>
  </div>
</template>
