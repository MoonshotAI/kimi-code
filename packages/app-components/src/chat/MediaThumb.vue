<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import VideoRailPreview from './VideoRailPreview.vue';
import { Icon, Spinner, Tooltip } from '@moonshot-ai/app-ui';

const props = withDefaults(
  defineProps<{
    kind: 'image' | 'video';
    name?: string;
    url?: string;
    thumbnailUrl?: string;
    fileId?: string;
    sessionId?: string;
    uploading?: boolean;
    error?: boolean;
    ordinal?: number;
    mentionable?: boolean;
    mentionLabel?: string;
    removable?: boolean;
    removeLabel?: string;
    size?: 'default' | 'composer' | 'rail';
    reorderable?: boolean;
    dragging?: boolean;
  }>(),
  { uploading: false, error: false, mentionable: false, removable: false, size: 'default', reorderable: false, dragging: false },
);

const emit = defineEmits<{
  activate: [img: HTMLImageElement | null];
  mention: [];
  remove: [];
}>();

function onActivate(e: MouseEvent): void {
  const button = e.currentTarget as HTMLButtonElement;
  if (e.detail > 0) button.blur();
  emit('activate', button.querySelector('img'));
}

const { t } = useI18n();

const label = computed(() => {
  if (props.name) return props.name;
  return props.kind === 'video' ? t('composer.attachmentVideo') : t('composer.attachmentImage');
});

const accessibleLabel = computed(() => {
  const status = props.uploading
    ? t('composer.uploading')
    : props.error
      ? t('composer.uploadFailed')
      : '';
  return status === '' ? label.value : `${label.value} ${status}`;
});

const isLocalUrl = computed(() => props.url?.startsWith('blob:') === true || props.url?.startsWith('data:') === true);
</script>

<template>
  <span class="media-thumb" :class="[{ 'is-error': error, uploading, 'is-reorderable': reorderable, 'is-dragging': dragging }, `is-${size}`]">
    <Tooltip :text="error ? t('composer.uploadFailed') : null">
      <button
        type="button"
        class="media-thumb-btn"
        :aria-label="accessibleLabel"
        :aria-busy="uploading"
        :aria-keyshortcuts="reorderable ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined"
        @click="onActivate"
      >
        <img
          v-if="thumbnailUrl"
          class="media-thumb-media"
          :src="thumbnailUrl"
          alt=""
          draggable="false"
        />
        <VideoRailPreview
          v-else-if="kind === 'video' && fileId && !isLocalUrl"
          :file-id="fileId"
          :session-id="sessionId"
          class="media-thumb-media media-thumb-tile"
        />
        <AuthMedia
          v-else-if="url && (kind === 'image' || isLocalUrl)"
          :url="url!"
          :kind="kind"
          :file-id="isLocalUrl ? undefined : fileId"
          :session-id="isLocalUrl ? undefined : sessionId"
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
    </Tooltip>
    <span
      v-if="ordinal !== undefined || mentionable || removable"
      class="media-thumb-dock"
      :class="{ 'has-tools': mentionable || removable }"
    >
      <span v-if="mentionable || removable" class="media-thumb-actions">
        <span v-if="mentionable" class="media-thumb-tool-slot media-thumb-mention-slot">
          <Tooltip :text="mentionLabel">
            <button
              type="button"
              class="media-thumb-tool media-thumb-mention"
              :aria-label="mentionLabel"
              @mousedown.prevent
              @click.stop="emit('mention')"
            >
              <Icon name="at" size="sm" />
            </button>
          </Tooltip>
        </span>
        <span v-if="removable" class="media-thumb-tool-slot media-thumb-rm-slot">
          <Tooltip :text="removeLabel ?? t('composer.remove')">
            <button
              type="button"
              class="media-thumb-tool media-thumb-rm"
              :aria-label="removeLabel ?? t('composer.remove')"
              @click.stop="emit('remove')"
            >
              <Icon name="trash" size="sm" />
            </button>
          </Tooltip>
        </span>
      </span>
      <span v-if="ordinal !== undefined" class="media-thumb-ordinal" aria-hidden="true">
        {{ ordinal }}
      </span>
    </span>
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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--duration-fast) ease;
}
.media-thumb-btn:hover {
  border-color: var(--color-line-strong);
}
.media-thumb.is-reorderable .media-thumb-btn {
  user-select: none;
}
.media-thumb.is-dragging {
  cursor: grabbing;
}
.media-thumb.is-dragging .media-thumb-btn {
  opacity: 0.55;
  cursor: grabbing;
}
.media-thumb.is-dragging .media-thumb-tool {
  cursor: grabbing;
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
.media-thumb.is-composer .media-thumb-media {
  width: var(--p-composer-media-thumb);
  height: var(--p-composer-media-thumb);
}
.media-thumb.is-rail .media-thumb-media {
  width: var(--p-composer-media-thumb);
  height: var(--p-composer-media-thumb);
}
.media-thumb.is-composer .media-thumb-btn {
  border-radius: var(--radius-composer-media);
  corner-shape: var(--corner-shape-composer);
}
.media-thumb.is-rail .media-thumb-btn {
  border-radius: var(--radius-lg);
}
.media-thumb-tile {
  object-fit: none;
}
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
  border: var(--p-hairline) solid var(--color-line);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
}
.media-thumb-badge.is-error {
  color: var(--color-danger);
  border-color: var(--color-danger-bd);
}
.media-thumb-dock {
  position: absolute;
  right: var(--space-1);
  bottom: var(--space-1);
  z-index: 1;
  color: var(--color-text-on-scrim);
  pointer-events: none;
}
.media-thumb.is-composer .media-thumb-dock {
  inset: 0;
}
.media-thumb.is-composer .media-thumb-dock.has-tools::before {
  position: absolute;
  inset: var(--p-hairline);
  border-radius: calc(var(--radius-composer-media) - var(--p-hairline));
  corner-shape: var(--corner-shape-composer);
  background: var(--color-scrim);
  content: '';
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.media-thumb-ordinal {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: var(--p-composer-media-control);
  height: var(--p-composer-media-control);
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-md);
  background: var(--color-scrim-strong);
  font-size: var(--text-2xs);
  font-weight: var(--weight-section-label);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.media-thumb.is-composer .media-thumb-ordinal {
  position: absolute;
  right: var(--space-1);
  bottom: var(--space-1);
  border-radius: var(--radius-composer-media-control);
  corner-shape: var(--corner-shape-composer);
  transition: opacity var(--duration-fast) var(--ease-out);
}
.media-thumb.is-error .media-thumb-btn {
  border-color: var(--color-danger-bd);
}
.media-thumb-actions {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, -50%);
  transition: opacity var(--duration-fast) var(--ease-out);
}
.media-thumb-tool-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--p-composer-media-action);
  height: var(--p-composer-media-action);
  pointer-events: none;
}
.media-thumb-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  border-radius: var(--radius-composer-media-control);
  corner-shape: var(--corner-shape-composer);
  background: var(--color-scrim-strong);
  color: inherit;
  cursor: pointer;
  pointer-events: none;
  transition:
    background var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.media-thumb.is-composer:not(.is-dragging):hover .media-thumb-dock.has-tools::before,
.media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-dock.has-tools::before {
  opacity: 1;
  transition-duration: var(--duration-base);
}
.media-thumb.is-composer:not(.is-dragging):hover .media-thumb-actions,
.media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-actions {
  opacity: 1;
  pointer-events: auto;
}
.media-thumb.is-composer:not(.is-dragging):hover .media-thumb-tool-slot,
.media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-tool-slot,
.media-thumb.is-composer:not(.is-dragging):hover .media-thumb-tool,
.media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-tool {
  pointer-events: auto;
}
.media-thumb.is-composer:not(.is-dragging):hover .media-thumb-ordinal,
.media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-ordinal {
  opacity: 0;
}
.media-thumb-tool:hover {
  background: color-mix(in srgb, var(--color-scrim-strong) 80%, var(--color-text-on-scrim) 20%);
}
.media-thumb-tool:active {
  transform: scale(0.96);
}
.media-thumb-tool:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
@media (hover: none) {
  .media-thumb.is-composer .media-thumb-dock.has-tools::before {
    display: none;
  }
  .media-thumb.is-composer:not(.is-dragging):hover .media-thumb-ordinal,
  .media-thumb.is-composer:not(.is-dragging):focus-within .media-thumb-ordinal {
    opacity: 1;
  }
  .media-thumb-actions {
    inset: 0;
    display: block;
    opacity: 1;
    transform: none;
  }
  .media-thumb-tool-slot {
    position: absolute;
    width: var(--touch-target-min);
    height: var(--touch-target-min);
    opacity: 1;
    pointer-events: none;
  }
  .media-thumb-mention-slot {
    display: none;
  }
  .media-thumb-tool {
    position: absolute;
    width: var(--touch-target-min);
    height: var(--touch-target-min);
    border-radius: 0;
    background: transparent;
    pointer-events: auto;
  }
  .media-thumb-tool::before {
    position: absolute;
    z-index: 0;
    width: var(--icon-button-sm);
    height: var(--icon-button-sm);
    border-radius: var(--radius-full);
    background: var(--color-scrim-strong);
    content: '';
  }
  .media-thumb-tool :deep(svg) {
    position: relative;
    z-index: 1;
  }
  .media-thumb-tool:hover {
    background: transparent;
  }
  .media-thumb-rm {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
    padding: var(--space-1);
  }
  .media-thumb-rm::before {
    top: var(--space-1);
    right: var(--space-1);
  }
  .media-thumb-rm :deep(svg) {
    position: absolute;
    top: calc(var(--space-1) + var(--icon-button-sm) / 2);
    right: calc(var(--space-1) + var(--icon-button-sm) / 2);
    transform: translate(50%, -50%);
  }
  .media-thumb-rm-slot {
    top: 0;
    right: 0;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .media-thumb-dock::before,
  .media-thumb-actions,
  .media-thumb-ordinal {
    transition: none;
  }
}
</style>
