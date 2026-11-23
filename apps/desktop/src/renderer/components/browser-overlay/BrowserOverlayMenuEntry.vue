<script setup lang="ts">
import { ref } from 'vue';
import { Favicon, MetricBadge, Icon, IconButton, Kbd, MenuItem, ProgressBar, SegmentedControl } from '@moonshot-ai/app-ui';
import type { BrowserOverlayMenuItem } from '../../../shared/browser-overlay';
import BrowserOverlayNotice from './BrowserOverlayNotice.vue';
import BrowserOverlayZoomItem from './BrowserOverlayZoomItem.vue';
import { findBrowserTextMatches, splitBrowserTextHighlights, type BrowserTextRange } from '../../lib/browserTextHighlight';

const props = defineProps<{ item: BrowserOverlayMenuItem; iconGutter: boolean; listbox?: boolean; highlightQuery?: string }>();
const failedFavicon = ref<string>();
const emit = defineEmits<{ action: [id: string] }>();

function segments(text: string, ranges?: readonly BrowserTextRange[]) {
  return splitBrowserTextHighlights(text, ranges ?? (props.highlightQuery ? findBrowserTextMatches(text, props.highlightQuery) : undefined));
}
</script>

<template>
  <MenuItem v-if="item.kind === 'separator'" separator />
  <div
    v-else-if="item.kind === 'section' || item.kind === 'note'"
    :class="['overlay-menu-copy', `is-${item.kind}`, { 'is-xs': item.kind === 'note' && item.size === 'xs' }]"
  >{{ item.label }}</div>
  <div v-else-if="item.kind === 'choices'" class="overlay-menu-choices" :class="{ 'is-disabled': item.disabled }" role="group" :aria-label="item.label">
    <span class="overlay-menu-choice-label"><Icon v-if="item.icon" :name="item.icon" size="sm" aria-hidden="true" />{{ item.label }}<BrowserOverlayNotice v-if="item.notice" :message="item.notice.message" :link-label="item.notice.linkLabel" @open="emit('action', item.notice!.action)" /></span>
    <SegmentedControl :model-value="item.value" :options="item.options.map(option => ({ value: option.id, label: option.label }))" size="xs" :disabled="item.disabled" @update:model-value="emit('action', $event)" />
  </div>
  <BrowserOverlayZoomItem v-else-if="item.kind === 'zoom'" :item="item" :show-icon-gutter="iconGutter" @action="emit('action', $event)" />
  <div v-else-if="item.kind === 'item'" :class="['overlay-menu-row-group', { 'has-actions': item.actions?.length }]">
  <MenuItem :class="['overlay-menu-row', { 'has-metrics': item.metrics?.length }]" :data-tone="item.tone" :active="item.selected" :role="listbox ? 'option' : item.selected === undefined ? undefined : 'menuitemradio'" :aria-checked="listbox ? undefined : item.selected" :aria-selected="listbox ? item.selected : undefined" :danger="item.danger" :disabled="item.disabled" @click="emit('action', item.id)">
    <span v-if="iconGutter" class="overlay-menu-icon" aria-hidden="true"><Favicon v-if="item.favicon && item.favicon !== failedFavicon" :src="item.favicon" class="overlay-menu-favicon" referrerpolicy="no-referrer" @error="failedFavicon = item.favicon" /><Icon v-else-if="item.icon" :name="item.icon" :style="item.tone ? { color: `var(--color-${item.tone})` } : undefined" /></span>
    <span class="overlay-menu-text">
      <span class="overlay-menu-title"><span class="overlay-menu-label"><template v-for="(segment, index) in segments(item.label, item.labelRanges)" :key="index"><strong v-if="segment.match" class="overlay-menu-match">{{ segment.text }}</strong><template v-else>{{ segment.text }}</template></template></span><span v-if="item.metrics?.length" class="overlay-menu-metrics"><MetricBadge v-for="metric in item.metrics" :key="metric.label" :label="metric.label" muted>{{ metric.value }}</MetricBadge></span></span>
      <span v-if="item.description" class="overlay-menu-description"><template v-for="(segment, index) in segments(item.description, item.descriptionRanges)" :key="index"><strong v-if="segment.match" class="overlay-menu-match">{{ segment.text }}</strong><template v-else>{{ segment.text }}</template></template></span>
      <ProgressBar v-if="item.progress" class="overlay-menu-progress" :class="{ 'is-paused': item.progress.paused }" :value="item.progress.value" :label="item.progress.label" />
    </span>
    <span v-if="item.detail" class="overlay-menu-detail">{{ item.detail }}</span>
    <Icon v-if="item.starred" name="star" size="sm" class="overlay-menu-star" style="color: var(--star)" />
    <Icon v-if="item.selected && !listbox" name="check" size="sm" class="overlay-menu-check" style="color: var(--color-accent)" />
    <Kbd v-if="item.shortcut?.length" :keys="item.shortcut" />
  </MenuItem>
  <span v-if="item.actions?.length" class="overlay-menu-actions">
    <IconButton v-for="action in item.actions" :key="action.id" size="sm" :label="action.label" :disabled="item.disabled" @click="emit('action', action.id)"><Icon :name="action.icon" /></IconButton>
  </span>
  </div>
</template>

<style scoped>
.overlay-menu-favicon { width: var(--space-4); height: var(--space-4); object-fit: contain; flex: none; }
.overlay-menu-row { align-items: flex-start; }
.overlay-menu-row-group:not(.has-actions) { display: contents; }
.overlay-menu-row-group.has-actions { display: flex; align-items: center; gap: var(--space-1); padding-inline-end: var(--space-1); }
.overlay-menu-row-group.has-actions > .overlay-menu-row { flex: 1; min-width: 0; }
.overlay-menu-actions { display: inline-flex; align-items: center; gap: var(--space-05); flex: none; }
.overlay-menu-progress { margin-top: var(--space-1); }
.overlay-menu-progress.is-paused :deep(.ui-progress-bar__indicator) { animation-play-state: paused; }
.overlay-menu-row.has-metrics { align-items: center; }
.overlay-menu-title { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.overlay-menu-metrics { display: inline-flex; align-items: center; gap: var(--space-1); flex: none; }
.overlay-menu-icon { display: inline-flex; width: var(--space-4); flex: none; color: var(--overlay-menu-tone, inherit); }
.overlay-menu-text { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.overlay-menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--overlay-menu-tone, inherit); }
.overlay-menu-description { font-size: var(--text-xs); font-weight: var(--weight-caption); line-height: var(--leading-normal); color: var(--color-text-muted); white-space: normal; overflow-wrap: anywhere; }
.overlay-menu-match { font-weight: var(--weight-section-label); }
.overlay-menu-row[role='option'] .overlay-menu-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overlay-menu-row[data-tone='warning'] { --overlay-menu-tone: var(--color-warning); }
.overlay-menu-row[data-tone='danger'] { --overlay-menu-tone: var(--color-danger); }
.overlay-menu-detail { color: var(--color-text-muted); font-size: var(--text-sm); flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overlay-menu-star { color: var(--star); flex-shrink: 0; }
.overlay-menu-check { color: var(--color-accent); flex-shrink: 0; }
.overlay-menu-copy { padding: var(--space-2) var(--menu-item-padding-inline); color: var(--color-text-muted); font-size: var(--text-sm); line-height: var(--leading-normal); white-space: normal; }
.overlay-menu-copy.is-note { width: 0; min-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
.overlay-menu-copy.is-note.is-xs { font-size: var(--text-xs); }
.overlay-menu-copy.is-section { font-weight: var(--weight-section-label); }
.overlay-menu-choice-label { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-option-label); line-height: var(--leading-tight); }
.overlay-menu-choice-label :deep(svg) { color: var(--color-text-muted); flex: none; }
.overlay-menu-choices { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2) 1rem; padding: var(--space-1) var(--menu-item-padding-inline); }
.overlay-menu-choices.is-disabled .overlay-menu-choice-label { color: var(--color-text-muted); }
</style>
