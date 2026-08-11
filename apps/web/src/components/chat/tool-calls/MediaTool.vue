<!-- apps/kimi-web/src/components/chat/tool-calls/MediaTool.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { OpenMediaRequest, ToolCall } from '../../../types';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import AuthMedia from '../AuthMedia.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();

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

/** Local object URLs always load directly; an uploaded video's bare url is a
    provider-side `ms://…` the browser cannot load, so file-store videos render
    a static tile instead of a fetched first frame (MediaThumb's rules) — the
    modal player does the authenticated fetch on open. */
const isLocalUrl = computed(() => media.value?.url.startsWith('blob:') ?? false);
const videoStaticTile = computed(() => {
  const m = media.value;
  return m?.kind === 'video' && m.fileId !== undefined && !isLocalUrl.value;
});

function openMediaPreview(e: MouseEvent): void {
  const m = media.value;
  if (m?.kind !== 'image' && m?.kind !== 'video') return;
  // An image passes its clicked <img> as the preview's zoom origin (and byte
  // source); the video modal doesn't need one.
  const originImg = m.kind === 'image' ? (e.currentTarget as HTMLElement).querySelector('img') : null;
  emit('openMedia', { media: m, originImg });
}
</script>

<template>
  <div v-if="media" class="media-tool" :class="{ mob: mobile }">
    <Tooltip :text="media.path || mediaTitle">
      <div class="media-title">{{ mediaTitle }}</div>
    </Tooltip>
    <!-- Image and video clicks both open the floating MediaLightbox preview —
         PhotoSwipe for images, the custom modal player for videos — the same
         preview user-bubble attachments get. -->
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
    <Tooltip v-else-if="media.kind === 'video'" :text="media.path || mediaTitle">
      <button
        type="button"
        class="media-image-button media-video-button"
        :aria-label="media.path ? basename(media.path) : mediaTitle"
        @click="openMediaPreview"
      >
        <span v-if="videoStaticTile" class="media-video-tile" aria-hidden="true" />
        <AuthMedia
          v-else
          :url="media.url"
          kind="video"
          :file-id="isLocalUrl ? undefined : media.fileId"
          media-class="media-video"
          :controls="false"
          muted
        />
        <span class="media-play-badge" aria-hidden="true">
          <Icon name="play" size="sm" />
        </span>
      </button>
    </Tooltip>
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
.media-video {
  display: block;
}
/* Video tile button: the play badge centers over it (MediaThumb's badge
   language — a raised 22px circle). */
.media-video-button {
  position: relative;
}
.media-video-tile {
  display: block;
  width: 320px;
  max-width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--color-well);
}
.media-play-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
}
</style>
