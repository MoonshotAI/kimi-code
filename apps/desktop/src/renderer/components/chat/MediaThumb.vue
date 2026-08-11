<!-- apps/web/src/components/chat/MediaThumb.vue -->
<!-- One image/video attachment rendered as a rounded-rect thumbnail — the
     SAME component for the composer's pending-attachment strip and for media
     in sent messages (files keep the AttachmentChip pill); composer-only
     states (uploading / error / remove) arrive as props. File-store videos
     render a static play tile instead of a fetched first frame. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import { Icon, Spinner, Tooltip } from '@moonshot-ai/app-ui';

const props = withDefaults(
  defineProps<{
    kind: 'image' | 'video';
    /** Undefined only for pasted media without a name — a generic label shows. */
    name?: string;
    /** Thumbnail source: a local object URL (composer drafts) or the file URL. */
    url?: string;
    /** When present, image bytes are fetched with auth (a bare file URL
        401s); local object URLs take precedence and skip the refetch. */
    fileId?: string;
    /** Composer: upload in flight — spinner badge over the thumb. */
    uploading?: boolean;
    /** Composer: upload failed — danger border, info badge. */
    error?: boolean;
    /** Composer: show a remove button. */
    removable?: boolean;
    /** Accessible label for the remove button. */
    removeLabel?: string;
  }>(),
  { uploading: false, error: false, removable: false },
);

const emit = defineEmits<{
  /** Primary action (opens the preview) — the parent decides. Carries the
      thumbnail <img> so an image preview can zoom from its position and reuse
      its already-loaded bytes; null for the static video tile. */
  activate: [img: HTMLImageElement | null];
  remove: [];
}>();

function onActivate(e: MouseEvent): void {
  emit('activate', (e.currentTarget as HTMLElement).querySelector('img'));
}

const { t } = useI18n();

/** Tooltip/accessible label — pasted media may be unnamed. */
const label = computed(() => {
  if (props.name) return props.name;
  return props.kind === 'video' ? t('composer.attachmentVideo') : t('composer.attachmentImage');
});

/** Local object URLs (composer drafts) always play — they win over the authed refetch. */
const isLocalUrl = computed(() => props.url?.startsWith('blob:') ?? false);

/** File-store videos skip the authed blob fetch and render a static tile. */
const staticTile = computed(
  () => !props.url || (props.kind === 'video' && props.fileId !== undefined && !isLocalUrl.value),
);
</script>

<template>
  <span class="media-thumb" :class="{ 'is-error': error, uploading }">
    <button
      type="button"
      class="media-thumb-btn"
      :title="label"
      :aria-label="label"
      @click="onActivate"
    >
      <AuthMedia
        v-if="!staticTile"
        :url="url!"
        :kind="kind"
        :file-id="isLocalUrl ? undefined : fileId"
        media-class="media-thumb-media"
        :controls="false"
        muted
      />
      <span v-else class="media-thumb-media media-thumb-tile" aria-hidden="true" />
      <span v-if="uploading" class="media-thumb-badge" aria-hidden="true">
        <Spinner size="sm" :label="t('composer.uploading')" />
      </span>
      <span v-else-if="error" class="media-thumb-badge is-error" aria-hidden="true">
        <Icon name="info" size="sm" />
      </span>
      <span v-else-if="kind === 'video'" class="media-thumb-badge" aria-hidden="true">
        <Icon name="play" size="sm" />
      </span>
    </button>
    <Tooltip v-if="removable" :text="removeLabel ?? t('composer.remove')">
      <button
        type="button"
        class="media-thumb-rm"
        :aria-label="removeLabel ?? t('composer.remove')"
        @click="emit('remove')"
      >
        <Icon name="close" size="sm" />
      </button>
    </Tooltip>
  </span>
</template>

<style scoped>
.media-thumb {
  position: relative;
  flex: none;
  display: inline-flex;
}
.media-thumb-btn {
  display: block;
  padding: 0;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--duration-fast) ease;
}
.media-thumb-btn:hover {
  border-color: var(--color-line-strong);
}
.media-thumb-btn:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.media-thumb-media {
  display: block;
  width: 64px;
  height: 64px;
  object-fit: cover;
}
/* Static tile (see the header note) — the button's sunken fill shows through. */
.media-thumb-tile {
  object-fit: none;
}
/* Center badge: play glyph / upload spinner / error info — the same raised
   circle language as the lightbox close button. */
.media-thumb-badge {
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
.media-thumb-badge.is-error {
  color: var(--color-danger);
  border-color: var(--color-danger-bd);
}
.media-thumb.is-error .media-thumb-btn {
  border-color: var(--color-danger-bd);
}
.media-thumb-rm {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-scrim);
  color: var(--color-text-on-scrim);
  cursor: pointer;
}
.media-thumb-rm:hover {
  background: var(--color-text);
  color: var(--color-bg);
}
.media-thumb-rm:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
