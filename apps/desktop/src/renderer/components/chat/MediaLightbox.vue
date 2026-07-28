<!-- apps/web/src/components/chat/MediaLightbox.vue
     Floating preview overlay for media attachments — the sent-message chips
     and the composer's pending-attachment strip open the same modal. A
     canonical modal, not a local floating div: it teleports to <body> (no
     ancestor's overflow or container-type can clip it or capture its fixed
     geometry) and registers with the shared dialog stack
     (openDialogCount) — App's side-panel Esc handler and the conversation's
     Esc-interrupt both defer to open overlays, so a plain window-level Esc
     handler owns the key while the preview is up (same pattern as the web-ui
     Dialog primitive). Bytes come through AuthMedia so file-store media
     loads with auth; local object URLs (composer drafts) pass through. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import { Icon, Tooltip, openDialogCount } from '@moonshot-ai/web-ui';
import type { ToolMedia } from '../../types';

const props = defineProps<{ media: ToolMedia }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

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
let previouslyFocused: HTMLElement | null = null;

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
  openDialogCount.value += 1;
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKeydown);
  closeRef.value?.focus();
});

onBeforeUnmount(() => {
  openDialogCount.value = Math.max(0, openDialogCount.value - 1);
  window.removeEventListener('keydown', onKeydown);
  previouslyFocused?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="overlayRef"
      class="media-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogLabel"
      @mousedown.self="emit('close')"
    >
      <div class="media-lightbox-card">
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
        <div class="media-lightbox-frame">
          <AuthMedia
            :url="media.url"
            :kind="media.kind === 'video' ? 'video' : 'image'"
            :file-id="media.fileId"
            media-class="media-lightbox-media"
            :controls="media.kind === 'video'"
          />
        </div>
        <div v-if="caption" class="media-lightbox-name">{{ caption }}</div>
      </div>
    </div>
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
  background: var(--color-scrim);
}
.media-lightbox-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: min(960px, calc(100vw - var(--space-6) * 2));
  max-height: calc(100vh - var(--space-6) * 2);
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
  max-height: calc(100vh - var(--space-6) * 4);
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
/* Close affordance: a raised-surface 36px circle (tokened, matches the
   thumbnail play badge) plus a ::before halo stretching the hit area to ~48px,
   so it stays easy to click without visually growing the button. */
.media-lightbox-close {
  position: absolute;
  top: calc(var(--space-3) * -1);
  right: calc(var(--space-3) * -1);
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
  z-index: 1;
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
