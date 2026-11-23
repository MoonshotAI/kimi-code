<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { matchRanges, type SlashCommand, type SlashMatchRanges } from '@moonshot-ai/app-core/lib';
import { mentionIconSvg } from '@moonshot-ai/app-composer/features/mention';
import ComposerMenuHints from './ComposerMenuHints.vue';
import ComposerMenuSectionLabel from './ComposerMenuSectionLabel.vue';
import { useComposerMenuScroll } from './menuScroll';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  items: SlashCommand[];
  activeIndex: number;
  query?: string;
  ranges?: SlashMatchRanges[];
  layout?: 'popup' | 'sheet';
}>(), {
  query: '',
  layout: 'popup',
});

const emit = defineEmits<{
  select: [item: SlashCommand];
  hover: [index: number];
}>();

function pieces(text: string, ranges?: [number, number][]): { text: string; hit: boolean }[] {
  if (!ranges || ranges.length === 0) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

function shiftRanges(ranges: [number, number][] | undefined, offset: number): [number, number][] | undefined {
  return ranges
    ?.map(([s, e]): [number, number] => [Math.max(s - offset, 0), e - offset])
    .filter(([s, e]) => e > s);
}

const skillIcon = mentionIconSvg('skill', '', '');

function descText(item: SlashCommand): string {
  return item.isSkill ? item.desc : t(item.desc);
}

const segmented = computed(() =>
  props.items.map((item, i) => {
    const desc = descText(item);
    const ranges = props.ranges?.[i] ?? matchRanges(props.query, item.name, desc);
    const label = item.name.replace(/^\//, '');
    return {
      item,
      namePieces: pieces(label, shiftRanges(ranges.name, item.name.length - label.length)),
      desc,
      descPieces: pieces(desc, ranges.desc),
      dir: item.workspaceLabel ?? (item.sourceKind === undefined ? undefined : t(`mention.${item.sourceKind}`)),
      showCommandsHeader: item.isSkill !== true && i === 0,
      showSkillsHeader: item.isSkill === true && (i === 0 || props.items[i - 1]?.isSkill !== true),
    };
  }),
);

const { scrollEl, menuEl, thumb, maskImage, scrollMaxHeight, showHints, onScroll, onRowPointerMove, onMenuMouseDown, onThumbPointerDown } = useComposerMenuScroll({
  layout: () => props.layout,
  items: () => props.items,
  activeIndex: () => props.activeIndex,
  maxHeightVar: '--p-slash-menu-h',
  onHover: (index) => emit('hover', index),
});
defineExpose({ el: menuEl });
</script>

<template>
  <div ref="menuEl" class="slash-menu" :class="{ 'is-sheet': layout === 'sheet' }" data-menu-frame @mousedown="onMenuMouseDown">
    <div v-if="items.length === 0" class="slash-empty" role="status">{{ t('composer.noCommands') }}</div>
    <div id="composer-slash-menu" v-show="items.length > 0" ref="scrollEl" class="slash-scroll" role="listbox" :style="{ maskImage, maxHeight: scrollMaxHeight }" @scroll="onScroll">
      <template v-for="(entry, i) in segmented" :key="`${entry.item.name}-${i}`">
        <ComposerMenuSectionLabel v-if="entry.showCommandsHeader" class="slash-section-label">{{ t('composer.slashCommandsGroup') }}</ComposerMenuSectionLabel>
        <ComposerMenuSectionLabel v-if="entry.showSkillsHeader" class="slash-section-label" :after-section="i > 0">{{ t('mention.skills') }}</ComposerMenuSectionLabel>
        <div
          :id="`composer-slash-option-${i}`"
          class="slash-item"
          :class="{ active: i === props.activeIndex, 'is-skill': entry.item.isSkill === true }"
          role="option"
          :aria-selected="i === props.activeIndex"
          @pointermove="onRowPointerMove($event, i)"
          @mousedown.prevent="emit('select', entry.item)"
        >
          <span v-if="entry.item.isSkill === true" class="slash-icon" aria-hidden="true" v-html="skillIcon" />
          <span class="slash-name"><template v-for="(piece, pi) in entry.namePieces" :key="pi"><span v-if="piece.hit" class="slash-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
          <span class="slash-desc"><template v-for="(piece, pi) in entry.descPieces" :key="pi"><span v-if="piece.hit" class="slash-desc-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
          <span v-if="entry.dir" class="slash-dir">{{ entry.dir }}</span>
        </div>
      </template>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
    <ComposerMenuHints v-if="showHints" />
  </div>
</template>

<style scoped>
.slash-menu[data-menu-frame] {
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

.slash-menu.is-sheet[data-menu-frame] {
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
.slash-menu.is-sheet .slash-scroll {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}
.slash-menu.is-sheet .slash-item {
  margin: 0;
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}

.slash-scroll {
  max-height: var(--p-slash-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.slash-scroll::-webkit-scrollbar { display: none; }

.slash-icon {
  display: inline-flex;
  align-self: center;
  flex: none;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--muted);
}
.slash-icon :deep(svg) {
  display: block;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
}
.slash-item:hover .slash-icon,
.slash-item.active .slash-icon {
  color: var(--color-text-strong);
}

.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--menu-row-padding-block) var(--menu-row-padding-inline);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
  border-radius: var(--radius-menu-row);
}

.slash-item:hover {
  background: var(--color-hover);
}
.slash-item.active {
  background: var(--color-selected);
}

.slash-item + .slash-item {
  margin-top: var(--menu-rows-seam);
}

.slash-name {
  flex: none;
  max-width: 60%;
  color: var(--color-text);
  font-weight: 500;
  min-width: 0;
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.slash-match {
  font-weight: var(--weight-semibold);
}

.slash-empty {
  padding: var(--space-1-5) var(--space-1);
  color: var(--color-text-muted);
}

@media (hover: none) {
  .slash-item {
    min-height: var(--touch-target-min);
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}

.slash-desc {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--ui-b2);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash-desc-match {
  font-weight: var(--weight-semibold);
}

.slash-dir {
  flex: none;
  margin-left: auto;
  max-width: 12rem;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .slash-item:not(.is-skill) {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-05);
  }
  .slash-item:not(.is-skill) .slash-name {
    max-width: none;
  }
  .slash-item.is-skill .slash-name {
    max-width: 45%;
  }
}
</style>
