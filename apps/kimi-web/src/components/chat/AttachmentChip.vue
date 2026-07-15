<!-- apps/kimi-web/src/components/chat/AttachmentChip.vue -->
<!-- One attachment rendered as a pill chip — the SAME component for the
     composer's pending-attachment strip and for sent messages in the chat
     bubble. Context differences are props, not restyled variants:
       - composer: uploading spinner, error tint, remove button
       - bubble:   plain chip, click opens preview / downloads
     Tile rule: images show a real thumbnail, videos a play glyph, files an
     icon tinted by the --ft-* family hue for their extension. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import Tooltip from '../ui/Tooltip.vue';
import type { IconName } from '../../lib/icons';

const props = withDefaults(
  defineProps<{
    kind: 'image' | 'video' | 'file';
    /** Undefined only for pasted media without a name — a generic label shows. */
    name?: string;
    /** Thumbnail source for images (object URL or the authed file URL). */
    url?: string;
    /** When present, AuthMedia fetches image bytes with auth. */
    fileId?: string;
    mediaType?: string;
    size?: number;
    /** Composer: upload in flight — spinner replaces the ext badge. */
    uploading?: boolean;
    /** Composer: upload failed — chip tinted, info icon replaces the badge. */
    error?: boolean;
    /** Composer: show a remove button. */
    removable?: boolean;
    /** Accessible label for the remove button. */
    removeLabel?: string;
  }>(),
  { uploading: false, error: false, removable: false },
);

const emit = defineEmits<{
  /** Primary action (preview media / download file) — the parent decides. */
  activate: [];
  remove: [];
}>();

const { t } = useI18n();

/** Semantic hue per file family; unknown extensions use the neutral default. */
const TILE_CLASS: [RegExp, string][] = [
  [/^pdf$/i, 'ft-pdf'],
  [/^(doc|docx|md|txt|rtf)$/i, 'ft-doc'],
  [/^(xls|xlsx|csv|tsv)$/i, 'ft-sheet'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i, 'ft-zip'],
  [/^(png|jpe?g|gif|webp|avif|svg|heic|bmp)$/i, 'ft-img'],
  [/^(m[km]ov|mp4|webm|avi)$/i, 'ft-img'],
];

const ext = computed(() => {
  const fromName = props.name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  const e = fromName ?? props.mediaType?.split('/')[1]?.split('+')[0];
  return e ? e.toUpperCase() : undefined;
});

const tileClass = computed(() => {
  if (props.kind === 'video') return 'ft-img';
  if (props.kind !== 'file') return undefined;
  const e = ext.value ?? '';
  for (const [re, cls] of TILE_CLASS) {
    if (re.test(e)) return cls;
  }
  return undefined;
});

const fileIcon = computed<IconName>(() => {
  const e = ext.value ?? '';
  if (/^(txt|md|doc|docx|rtf|log)$/i.test(e)) return 'file-text';
  return 'file';
});

const displayName = computed(() => {
  if (props.name) return props.name;
  if (props.kind === 'image') return t('composer.attachmentImage');
  if (props.kind === 'video') return t('composer.attachmentVideo');
  return t('composer.attachmentFile');
});

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const title = computed(() => {
  const parts = [displayName.value];
  if (props.size !== undefined) parts.push(formatSize(props.size));
  return parts.join(' · ');
});
</script>

<template>
  <span
    class="att-chip"
    :class="[tileClass, { 'is-error': error, uploading }]"
    :title="title"
    :data-kind="kind"
  >
    <button type="button" class="att-activate" :aria-label="title" @click="emit('activate')">
      <span class="att-tile">
        <AuthMedia
          v-if="kind === 'image' && url"
          :url="url"
          kind="image"
          :alt="name"
          :file-id="fileId"
          media-class="att-thumb"
        />
        <Icon v-else-if="kind === 'video'" name="play" size="sm" />
        <Icon v-else-if="kind === 'image'" name="image" size="sm" />
        <Icon v-else :name="fileIcon" size="sm" />
      </span>
      <span class="att-name">{{ displayName }}</span>
      <Spinner v-if="uploading" size="sm" :label="t('composer.uploading')" />
      <span v-else-if="error" class="att-err"><Icon name="info" size="sm" /></span>
      <span v-else-if="ext" class="att-ext">{{ ext }}</span>
    </button>
    <Tooltip v-if="removable" :text="removeLabel ?? t('composer.remove')">
      <button type="button" class="att-rm" :aria-label="removeLabel ?? t('composer.remove')" @click="emit('remove')">
        <Icon name="close" size="sm" />
      </button>
    </Tooltip>
  </span>
</template>

<style scoped>
.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 4px 9px 4px 5px;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: 999px;
  font-size: var(--ui-font-size-sm);
  transition: border-color var(--duration-fast) ease;
}
.att-chip:hover {
  border-color: var(--color-line-strong);
}
.att-activate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.att-activate:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: 999px;
}
.att-tile {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--ft-file);
  background: var(--ft-file-soft);
}
.att-tile :deep(.att-thumb) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.att-chip.ft-pdf .att-tile { color: var(--ft-pdf); background: var(--ft-pdf-soft); }
.att-chip.ft-doc .att-tile { color: var(--ft-doc); background: var(--ft-doc-soft); }
.att-chip.ft-sheet .att-tile { color: var(--ft-sheet); background: var(--ft-sheet-soft); }
.att-chip.ft-zip .att-tile { color: var(--ft-zip); background: var(--ft-zip-soft); }
.att-chip.ft-code .att-tile { color: var(--ft-code); background: var(--ft-code-soft); }
.att-chip.ft-img .att-tile { color: var(--ft-img); background: var(--ft-img-soft); }
.att-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.att-ext {
  flex: none;
  font-size: calc(var(--ui-font-size-sm) - 2px);
  font-weight: var(--weight-semibold, 600);
  letter-spacing: .02em;
  color: var(--ft-file);
  background: var(--ft-file-soft);
  border-radius: var(--radius-xs);
  padding: 1px 4px;
}
.att-chip.ft-pdf .att-ext { color: var(--ft-pdf); background: var(--ft-pdf-soft); }
.att-chip.ft-doc .att-ext { color: var(--ft-doc); background: var(--ft-doc-soft); }
.att-chip.ft-sheet .att-ext { color: var(--ft-sheet); background: var(--ft-sheet-soft); }
.att-chip.ft-zip .att-ext { color: var(--ft-zip); background: var(--ft-zip-soft); }
.att-chip.ft-code .att-ext { color: var(--ft-code); background: var(--ft-code-soft); }
.att-chip.ft-img .att-ext { color: var(--ft-img); background: var(--ft-img-soft); }
.att-chip.is-error {
  border-color: var(--color-danger-bd);
}
.att-chip.is-error .att-err {
  flex: none;
  display: flex;
  align-items: center;
  color: var(--color-danger);
}
.att-rm {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
}
.att-rm:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.att-rm:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
