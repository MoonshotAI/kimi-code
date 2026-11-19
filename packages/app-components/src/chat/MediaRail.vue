<script setup lang="ts">
import { computed } from 'vue';
import type { TurnAttachment } from '@moonshot-ai/app-core/client/types';
import MediaThumb from './MediaThumb.vue';

const props = defineProps<{
  attachments: readonly TurnAttachment[];
  label: string;
}>();

const emit = defineEmits<{
  activate: [attachment: TurnAttachment, img: HTMLImageElement | null];
}>();

const media = computed(() =>
  props.attachments.filter(
    (attachment) => attachment.kind === 'image' || attachment.kind === 'video',
  ),
);
</script>

<template>
  <div class="media-rail" role="list" :aria-label="label">
    <MediaThumb
      v-for="(attachment, index) in media"
      :key="`${attachment.sessionId ?? ''}:${attachment.fileId ?? attachment.url}:${index}`"
      role="listitem"
      size="rail"
      :kind="attachment.kind === 'video' ? 'video' : 'image'"
      :name="attachment.name"
      :url="attachment.url"
      :file-id="attachment.fileId"
      :session-id="attachment.sessionId"
      :ordinal="attachment.mediaOrdinal"
      @activate="emit('activate', attachment, $event)"
    />
  </div>
</template>

<style scoped>
.media-rail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.media-rail::-webkit-scrollbar {
  display: none;
}
</style>
