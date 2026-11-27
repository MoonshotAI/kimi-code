<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { attachmentKindIconSvg } from '@moonshot-ai/app-composer/features/attachment';
import { fileMentionIconSvg, mentionIconSvg, mentionMatchSpans, type MentionMatchSpan } from '@moonshot-ai/app-composer/features/mention';
import type { MentionItem } from '@moonshot-ai/app-client/composables';
import { iconSvg } from '@moonshot-ai/app-ui/icons';
import type { FileItem } from '@moonshot-ai/app-core/client/types';
import { skillDirectoryName, skillIdentity, skillSourceKind } from '@moonshot-ai/app-core/lib';
import AuthMedia from '../chat/AuthMedia.vue';
import VideoRailPreview from '../chat/VideoRailPreview.vue';
import ComposerMenuHints from './ComposerMenuHints.vue';
import ComposerMenuSectionLabel from './ComposerMenuSectionLabel.vue';
import { useComposerMenuScroll } from './menuScroll';

export type { FileItem };

const props = withDefaults(defineProps<{
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
  query?: string;
  layout?: 'popup' | 'sheet';
  submenuTitle?: string;
}>(), { query: '', layout: 'popup', submenuTitle: undefined });

const emit = defineEmits<{
  select: [item: MentionItem];
  hover: [index: number];
  back: [];
}>();

const { t } = useI18n();

function rowKey(item: MentionItem): string {
  if (item.kind === 'browser') return `browser:${item.browser.captureId}`;
  if (item.kind === 'attachment') return `attachment:${item.attachment.entry.attId}`;
  if (item.kind === 'session-group') return 'session-group';
  if (item.kind === 'session') return `session:${item.session.id}`;
  return item.kind === 'skill' ? `skill:${skillIdentity(item.skill)}` : item.file.path;
}

function rowSection(item: MentionItem): 'media' | 'file' | 'skill' | 'browser' | 'session' {
  if (item.kind === 'browser') return 'browser';
  if (item.kind === 'attachment') {
    return item.attachment.entry.kind === 'image' || item.attachment.entry.kind === 'video'
      ? 'media'
      : 'file';
  }
  if (item.kind === 'skill') return 'skill';
  if (item.kind === 'session-group' || item.kind === 'session') return 'session';
  return 'file';
}

function startsSection(index: number): boolean {
  return index === 0 || rowSection(props.items[index]!) !== rowSection(props.items[index - 1]!);
}

function sectionLabel(item: MentionItem): string {
  if (item.kind === 'browser') return t('browserReference.group');
  if (rowSection(item) === 'media') return t('composer.imagesAndVideos');
  if (item.kind === 'skill') return t('mention.skills');
  if (rowSection(item) === 'session') return '';
  return t('composer.addFiles');
}

const searchingLabel = computed(() =>
  props.query === '' ? t('mention.searching') : t('mention.searchingFor', { query: props.query }),
);

const searchingNeedsHeader = computed(() => {
  if (props.submenuTitle !== undefined) return false;
  const last = props.items.at(-1);
  return last === undefined || rowSection(last) !== 'file';
});

function rowIcon(item: MentionItem): string {
  if (item.kind === 'browser') return iconSvg('browser', 'sm');
  if (item.kind === 'attachment') return attachmentKindIconSvg(item.attachment.entry.kind);
  if (item.kind === 'skill') return mentionIconSvg('skill', '', item.skill.name);
  if (item.kind === 'session-group' || item.kind === 'session') return mentionIconSvg('session', '', '');
  return fileMentionIconSvg(item.file.path, item.file.name, item.kind === 'folder');
}

function sessionSpans(item: Extract<MentionItem, { kind: 'session' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.session.title, item.matchPositions, 0);
}

function sessionMeta(item: Extract<MentionItem, { kind: 'session' }>): string {
  return [item.session.workspaceName, item.session.time].filter((part) => part !== undefined && part !== '').join(' · ');
}

function rowDir(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

function skillSpans(item: Extract<MentionItem, { kind: 'skill' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.skill.name, item.matchPositions, 0);
}

function skillWorkspaceLabel(item: Extract<MentionItem, { kind: 'skill' }>): string | undefined {
  const workspace = skillDirectoryName(item.skill.workspaceDir);
  if (workspace !== undefined) return workspace;
  const source = skillSourceKind(item.skill.source);
  return source === undefined ? undefined : t(`mention.${source}`);
}

function attachmentLabelSpans(item: Extract<MentionItem, { kind: 'attachment' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.attachment.label, item.labelMatchPositions ?? [], 0);
}

function attachmentNameSpans(item: Extract<MentionItem, { kind: 'attachment' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.attachment.entry.name, item.nameMatchPositions ?? [], 0);
}

function attachmentHasPreview(item: Extract<MentionItem, { kind: 'attachment' }>): boolean {
  const entry = item.attachment.entry;
  return (entry.kind === 'image' || entry.kind === 'video') &&
    (entry.thumbnailUrl !== undefined || entry.previewUrl !== undefined || entry.fileId !== undefined);
}

function attachmentUsesLocalPreview(item: Extract<MentionItem, { kind: 'attachment' }>): boolean {
  const url = item.attachment.entry.previewUrl;
  return url?.startsWith('blob:') === true || url?.startsWith('data:') === true;
}

function nameSpans(file: FileItem): MentionMatchSpan[] {
  const path = file.path.endsWith('/') ? file.path.slice(0, -1) : file.path;
  return mentionMatchSpans(file.name, file.matchPositions, Math.max(0, path.length - file.name.length));
}

function dirSpans(file: FileItem): MentionMatchSpan[] {
  return mentionMatchSpans(rowDir(file.path), file.matchPositions, 0);
}

const headEl = ref<HTMLElement | null>(null);
const { scrollEl, menuEl, thumb, maskImage, scrollMaxHeight, showHints, onScroll, onRowPointerMove, onMenuMouseDown, onThumbPointerDown } = useComposerMenuScroll({
  layout: () => props.layout,
  items: () => props.items,
  activeIndex: () => props.activeIndex,
  maxHeightVar: '--p-mention-menu-h',
  headEl,
  refitOn: () => props.submenuTitle,
  contentOn: () => [props.items, props.loading],
  onHover: (index) => emit('hover', index),
});
defineExpose({ el: menuEl });
</script>

<template>
  <div ref="menuEl" class="mention-menu" :class="{ 'is-sheet': layout === 'sheet' }" data-menu-frame @mousedown="onMenuMouseDown">
    <button
      v-if="props.submenuTitle !== undefined"
      ref="headEl"
      type="button"
      tabindex="-1"
      class="mention-submenu-head"
      :aria-label="t('mention.backToMentions')"
      @mousedown.prevent="emit('back')"
    >
      <span class="mention-icon" aria-hidden="true" v-html="iconSvg('chevron-left', 'sm')" />
      <span>{{ props.submenuTitle }}</span>
    </button>
    <div v-if="!props.loading && props.items.length === 0" class="mention-state dim" role="status">{{ t('mention.noMatch') }}</div>
    <div
      id="composer-mention-menu"
      v-show="props.items.length > 0 || props.loading"
      ref="scrollEl"
      class="mention-scroll"
      role="listbox"
      :style="{ maskImage, maxHeight: scrollMaxHeight }"
      @scroll="onScroll"
    >
      <template v-for="(row, i) in props.items" :key="rowKey(row)">
        <ComposerMenuSectionLabel v-if="startsSection(i) && sectionLabel(row) !== ''" class="mention-section-label" :after-section="i > 0">
          {{ sectionLabel(row) }}
        </ComposerMenuSectionLabel>
        <div
          :id="`composer-mention-option-${i}`"
          class="mention-item"
          :class="{
            active: i === props.activeIndex,
            'section-start': i > 0 && startsSection(i) && sectionLabel(row) === '',
          }"
          role="option"
          :aria-selected="i === props.activeIndex"
          @pointermove="onRowPointerMove($event, i)"
          @mousedown.prevent="emit('select', row)"
        >
          <template v-if="row.kind === 'browser'">
            <span class="mention-attachment-thumb" aria-hidden="true">
              <img v-if="row.browser.thumbnail" class="mention-attachment-media" :src="row.browser.thumbnail" alt="" />
              <span v-else class="mention-attachment-icon" v-html="rowIcon(row)" />
            </span>
            <span class="mention-browser-text">
              <span class="mention-name">{{ row.browser.label }}</span>
              <span class="mention-meta">{{ row.browser.title }} · {{ row.browser.url }}</span>
            </span>
          </template>
          <template v-else-if="row.kind === 'attachment'">
            <span class="mention-attachment-thumb" aria-hidden="true">
              <img
                v-if="row.attachment.entry.thumbnailUrl"
                class="mention-attachment-media"
                :src="row.attachment.entry.thumbnailUrl"
                alt=""
              />
              <VideoRailPreview
                v-else-if="row.attachment.entry.kind === 'video' && row.attachment.entry.fileId && !attachmentUsesLocalPreview(row)"
                :file-id="row.attachment.entry.fileId"
                :session-id="row.attachment.entry.sessionId"
                class="mention-attachment-media"
              />
              <AuthMedia
                v-else-if="attachmentHasPreview(row) && (row.attachment.entry.kind !== 'video' || attachmentUsesLocalPreview(row))"
                :url="row.attachment.entry.previewUrl ?? ''"
                :kind="row.attachment.entry.kind === 'video' ? 'video' : 'image'"
                :file-id="attachmentUsesLocalPreview(row) ? undefined : row.attachment.entry.fileId"
                :session-id="attachmentUsesLocalPreview(row) ? undefined : row.attachment.entry.sessionId"
                media-class="mention-attachment-media"
                :controls="false"
                muted
              />
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span v-else class="mention-icon mention-attachment-icon" v-html="rowIcon(row)" />
            </span>
            <span class="mention-name"><template v-for="(span, k) in attachmentLabelSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span v-if="row.attachment.entry.name !== row.attachment.label" class="mention-meta"><template v-for="(span, k) in attachmentNameSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
          </template>
          <template v-else-if="row.kind === 'skill'">
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name"><template v-for="(span, k) in skillSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span class="mention-meta">{{ row.skill.description }}</span>
            <span v-if="skillWorkspaceLabel(row)" class="mention-dir">{{ skillWorkspaceLabel(row) }}</span>
          </template>
          <template v-else-if="row.kind === 'session-group'">
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name">{{ t('mention.sessions') }}</span>
            <span class="mention-icon mention-chevron" v-html="iconSvg('chevron-right', 'sm')" aria-hidden="true" />
          </template>
          <template v-else-if="row.kind === 'session'">
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name mention-session-title"><template v-for="(span, k) in sessionSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span v-if="sessionMeta(row)" class="mention-dir">{{ sessionMeta(row) }}</span>
          </template>
          <template v-else>
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name"><template v-for="(span, k) in nameSpans(row.file)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span v-if="rowDir(row.file.path)" class="mention-meta"><template v-for="(span, k) in dirSpans(row.file)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
          </template>
        </div>
      </template>
      <template v-if="props.loading">
        <ComposerMenuSectionLabel v-if="searchingNeedsHeader" class="mention-section-label" :after-section="props.items.length > 0">
          {{ t('composer.addFiles') }}
        </ComposerMenuSectionLabel>
        <div class="mention-searching dim" role="status">{{ searchingLabel }}</div>
      </template>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && props.items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
    <ComposerMenuHints v-if="showHints" />
  </div>
</template>

<style scoped>
.mention-menu[data-menu-frame] {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  padding: var(--space-1-5) var(--space-3);
  background: var(--color-menu-bg-frost);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  z-index: var(--z-dropdown);
}

.mention-menu.is-sheet[data-menu-frame] {
  position: static;
  padding: 0;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
  z-index: auto;
}
.mention-menu.is-sheet .mention-scroll {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}
.mention-menu.is-sheet .mention-item {
  margin: 0;
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}
.mention-menu.is-sheet .mention-section-label {
  margin-left: 0;
  margin-right: 0;
}
.mention-menu.is-sheet .mention-state {
  padding-left: var(--space-4);
}

.mention-scroll {
  max-height: var(--p-mention-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.mention-scroll::-webkit-scrollbar { display: none; }

.mention-state {
  padding: var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
}

.mention-submenu-head {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  width: calc(100% + 2 * var(--menu-row-hug));
  margin: 0 calc(-1 * var(--menu-row-hug)) var(--space-1);
  padding: var(--menu-row-padding-block) var(--space-2);
  border: none;
  border-radius: var(--radius-menu-row);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  text-align: left;
  cursor: pointer;
}
.mention-submenu-head:hover {
  background: var(--color-hover);
  color: var(--color-text-strong);
}
.mention-menu.is-sheet .mention-submenu-head {
  width: 100%;
  margin: 0;
  padding-left: var(--space-4);
}

.mention-searching {
  padding: var(--menu-row-padding-block) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.dim {
  color: var(--color-text-muted);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--menu-row-padding-block) var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  border-radius: var(--radius-menu-row);
}

.mention-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--color-text-faint);
  flex-shrink: 0;
}

.mention-icon :deep(svg) {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  display: block;
}

.mention-attachment-thumb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-button-sm);
  height: var(--icon-button-sm);
  overflow: hidden;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: var(--color-well);
  color: var(--color-text-faint);
  flex-shrink: 0;
}

.mention-attachment-thumb :deep(.mention-attachment-media) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mention-attachment-icon {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}

.mention-attachment-icon :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}

.mention-item:hover .mention-icon,
.mention-item.active .mention-icon {
  color: var(--color-text-strong);
}

.mention-item:hover {
  background: var(--color-hover);
}
.mention-name {
  color: var(--color-text-strong);
}
.mention-item.active {
  background: var(--color-selected);
}

.mention-item + .mention-item {
  margin-top: var(--menu-rows-seam);
}
.mention-item.section-start {
  margin-top: var(--space-2);
}
@media (hover: none) {
  .mention-item {
    min-height: var(--touch-target-min);
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}

.mention-browser-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-05);
}
.mention-browser-text > .mention-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-name {
  color: var(--color-text);
  font-weight: 500;
  flex-shrink: 0;
}

.mention-name .mention-hit {
  color: var(--color-text-strong);
  font-weight: var(--weight-semibold);
}

.mention-session-title {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-chevron {
  margin-left: auto;
}

.mention-meta .mention-hit {
  color: var(--color-text);
}

.mention-meta {
  color: var(--color-text-muted);
  font-size: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-dir {
  flex: none;
  margin-left: auto;
  max-width: 12rem;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
