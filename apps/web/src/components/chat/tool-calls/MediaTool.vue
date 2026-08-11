<!-- apps/kimi-web/src/components/chat/tool-calls/MediaTool.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCall, ToolMedia } from '../../../types';
import { Tooltip } from '@moonshot-ai/app-ui';
import AuthMedia from '../AuthMedia.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });
const emit = defineEmits<{ openMedia: [media: ToolMedia] }>();

const media = computed(() => (props.tool.status === 'ok' ? props.tool.media : undefined));

function basename(path: string): string {
  return path.split(/[\\/]+/).pop() || path;
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const mediaTitle = computed(() => {
  const m = media.value;
  if (!m) return '';
  const parts = [m.path ? basename(m.path) : props.tool.name];
  if (m.mimeType) parts.push(m.mimeType);
  if (m.bytes !== undefined) parts.push(formatBytes(m.bytes));
  if (m.dimensions) parts.push(m.dimensions);
  return parts.join(' · ');
});

function openMediaPreview(): void {
  const m = media.value;
  if (m?.kind === 'image') emit('openMedia', m);
}
</script>

<template>
  <div v-if="media" class="media-tool" :class="{ mob: mobile }">
    <Tooltip :text="media.path || mediaTitle">
      <div class="media-title">{{ mediaTitle }}</div>
    </Tooltip>
    <Tooltip v-if="media.kind === 'image'" :text="media.path || mediaTitle">
      <button
        type="button"
        class="media-image-button"
        @click="openMediaPreview"
      >
        <img
          class="media-image"
          :src="media.url"
          :alt="media.path ? basename(media.path) : mediaTitle"
          loading="lazy"
        />
      </button>
    </Tooltip>
    <!-- Uploaded videos carry a provider-side `ms://…` url the browser cannot
         load; with a fileId the daemon's bytes are fetched with auth instead
         (same path as user-bubble videos). Inline data: URLs keep the bare
         <video>. -->
    <AuthMedia
      v-else-if="media.kind === 'video' && media.fileId !== undefined"
      kind="video"
      :url="media.url"
      :file-id="media.fileId"
      media-class="media-video"
    />
    <video
      v-else-if="media.kind === 'video'"
      class="media-video"
      :src="media.url"
      controls
      preload="metadata"
    />
    <audio v-else class="media-audio" :src="media.url" controls />
  </div>
</template>

<style scoped>
.media-tool {
  display: inline-flex;
  flex-direction: column;
  gap: 6px;
  max-width: 320px;
}
.media-title {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-image-button {
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius-md);
  overflow: hidden;
}
.media-image {
  display: block;
  max-width: 100%;
  border-radius: var(--radius-md);
  background: var(--media-alpha-canvas);
}
.media-video,
.media-audio {
  max-width: 100%;
  border-radius: var(--radius-md);
}
</style>
