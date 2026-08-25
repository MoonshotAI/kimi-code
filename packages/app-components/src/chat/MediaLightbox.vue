<!-- Preview entry for media attachments — the sent-message thumbnails, the
     composer's pending-attachment strip, and ReadMedia tool cards all open
     here. Two implementations behind one component:
       - image: PhotoSwipe (@moonshot-ai/app-client's lib/mediaPreview.ts) —
         the preview zooms out of the clicked thumbnail (which also donates
         its already-loaded bytes and natural dimensions). PhotoSwipe's own
         top bar is disabled, so this component renders the shared close
         button over it.
       - video: the custom modal below.
     Both share the same scrim and the same close button, fixed at the
     viewport's top-right. The preview teleports to <body> (no ancestor's
     overflow or container-type can clip it or capture its fixed geometry)
     and registers with the shared dialog stack (openDialogCount) — App's
     side-panel Esc handler and the conversation's Esc-interrupt both defer
     to open overlays, so the video modal's window-level Esc handler owns the
     key while it is up (same pattern as the app-ui Dialog primitive), while
     images let PhotoSwipe's own escKey handling own it.
     Bytes come through AuthMedia so file-store media loads with auth; local
     object URLs (composer drafts) pass through. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import { Icon, Tooltip, openDialogCount } from '@moonshot-ai/app-ui';
import { openImagePreview } from '@moonshot-ai/app-client/lib';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';
import type { ToolMedia } from '@moonshot-ai/app-core/client/types';

const props = defineProps<{
  media: ToolMedia;
  /** The clicked thumbnail <img> — the image preview's zoom origin. */
  originImg?: HTMLImageElement | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const isImage = computed(() => props.media.kind === 'image');

/** Caption under the media — only a real file name; unnamed pasted media
    (no path) shows no caption rather than a generic "Image"/"Video" label. */
const caption = computed(() => props.media.path ?? null);

const dialogLabel = computed(
  () =>
    caption.value ??
    (props.media.kind === 'video' ? t('composer.attachmentVideo') : t('composer.attachmentImage')),
);

const overlayRef = ref<HTMLElement | null>(null);
const closeRef = ref<HTMLButtonElement | null>(null);
/** Images: the close button shows only once PhotoSwipe is actually up —
 *  during the resolve gap (blob fetch / dim probe) there is no scrim or Esc
 *  ownership yet, so a floating button would hover over an interactive
 *  transcript. */
const imageOpened = ref(false);
let previouslyFocused: HTMLElement | null = null;
let cancelImagePreview: (() => void) | null = null;

const FOCUSABLE = 'button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // preventDefault also tells the conversation's Esc-interrupt the key is
    // spent (belt and braces — overlayOpen already covers it via the stack).
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key !== 'Tab' || !overlayRef.value) return;
  // Modal focus trap: keep Tab cycling over the preview's own controls while
  // the transcript behind the scrim is visually blocked.
  const list = overlayRef.value.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = list[0];
  const last = list[list.length - 1];
  if (!first || !last) return;
  if (!overlayRef.value.contains(document.activeElement)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  if (isImage.value) {
    cancelImagePreview = openImagePreview({
      api: getKimiWebApi(),
      media: props.media,
      thumbImg: props.originImg ?? null,
      onOpen: () => {
        imageOpened.value = true;
      },
      onClose: () => emit('close'),
    });
    return;
  }
  openDialogCount.value += 1;
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKeydown);
  closeRef.value?.focus();
});

onBeforeUnmount(() => {
  if (cancelImagePreview) {
    cancelImagePreview();
    cancelImagePreview = null;
    return;
  }
  openDialogCount.value = Math.max(0, openDialogCount.value - 1);
  window.removeEventListener('keydown', onKeydown);
  previouslyFocused?.focus();
});
</script>

<template>
  <!-- Both previews share the same close button at the same spot — the image
       side runs PhotoSwipe with its own top bar disabled. -->
  <Teleport to="body">
    <div
      v-if="!isImage"
      ref="overlayRef"
      class="media-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogLabel"
      @mousedown.self="emit('close')"
    >
      <Tooltip :text="t('model.close')">
        <button
          ref="closeRef"
          type="button"
          class="media-lightbox-close"
          :aria-label="t('model.close')"
          @click="emit('close')"
        >
          <Icon name="close" size="sm" />
        </button>
      </Tooltip>
      <!-- Frame clips the media (and a video's native controls) to the corner
           radius — a bare element would let controls square off the corners. -->
      <div class="media-lightbox-card">
        <div class="media-lightbox-frame">
          <AuthMedia
            :url="media.url"
            :kind="media.kind === 'video' ? 'video' : 'image'"
            :file-id="media.fileId"
            :session-id="media.sessionId"
            media-class="media-lightbox-media"
            :controls="media.kind === 'video'"
          />
        </div>
        <div v-if="caption" class="media-lightbox-name">{{ caption }}</div>
      </div>
    </div>
    <Tooltip v-else-if="imageOpened" :text="t('model.close')">
      <button
        type="button"
        class="media-lightbox-close"
        :aria-label="t('model.close')"
        @click="emit('close')"
      >
        <Icon name="close" size="sm" />
      </button>
    </Tooltip>
  </Teleport>
</template>

<style scoped>
.media-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  /* Same backdrop as the PhotoSwipe image preview (--pswp-bg). */
  background: var(--color-scrim-strong);
}
.media-lightbox-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: min(960px, calc(100vw - var(--space-6) * 2));
  max-height: calc(var(--app-height, 100vh) - var(--space-6) * 2);
}
.media-lightbox-frame {
  max-width: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg);
  box-shadow: var(--shadow-xl);
}
.media-lightbox-media {
  display: block;
  max-width: 100%;
  max-height: calc(var(--app-height, 100vh) - var(--space-6) * 4);
  object-fit: contain;
}
.media-lightbox-name {
  max-width: 100%;
  color: var(--color-text-on-scrim);
  font-size: var(--ui-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Close affordance — shared by both previews (PhotoSwipe's own top bar is
   disabled): a raised-surface 36px circle (tokened, matches the thumbnail
   play badge) fixed at the viewport's top-right, plus a ::before halo
   stretching the hit area to ~48px, so it stays easy to click without
   visually growing the button. On the above-modal rung so neither the
   PhotoSwipe root nor the video scrim (both --z-modal) can cover it. */
.media-lightbox-close {
  position: fixed;
  top: var(--space-4);
  right: var(--space-6);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  z-index: var(--z-modal-dropdown);
}
.media-lightbox-close::before {
  content: '';
  position: absolute;
  inset: -6px;
}
.media-lightbox-close:hover {
  border-color: var(--color-line-strong);
  background: var(--color-surface-sunken);
}
</style>
