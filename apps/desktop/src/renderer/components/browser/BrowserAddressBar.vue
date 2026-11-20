<script setup lang="ts">
import { v4 as randomUUID } from 'uuid';
import { onMounted, onUnmounted, ref } from 'vue';
import { nextBrowserMenuIndex } from '../../lib/browserMenuNavigation';
import { useI18n } from 'vue-i18n';
import { Icon, Input } from '@moonshot-ai/app-ui';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import type { BrowserHistoryEntry } from '../../../shared/browser-data';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { registerBrowserOverlayMenu, type BrowserOverlayMenuRegistration } from '../../lib/browserOverlayMenu';
import { browserSuggestionDisplayDifference, browserSuggestionVisibleChars, clipBrowserSuggestionDisplay, distinguishBrowserSuggestionUrls, groupBrowserHistorySuggestions, matchBrowserHistorySuggestions, type BrowserAddressSuggestion, type BrowserAddressSuggestionGroup, type BrowserSuggestionClip } from '../../lib/browserAddressSuggestions';
import { browserQueryTerms, findBrowserCommonRange, findBrowserTextMatches, foldBrowserText, type BrowserTextRange } from '../../lib/browserTextHighlight';

const props = defineProps<{ modelValue: string; url: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; navigate: []; focus: []; blur: [] }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const input = ref<InstanceType<typeof Input>>();
const focused = ref(false);
let pointerFocus = false;
let pendingArrowSteps: (1 | -1)[] = [];
let history: BrowserHistoryEntry[] | null = null;
let historyGroups: { history: BrowserHistoryEntry[]; groups: BrowserAddressSuggestionGroup[] } | null = null;
let historyRequest: Promise<BrowserHistoryEntry[] | undefined> | null = null;
let suggestions: BrowserAddressSuggestion[] = [];
let suggestionQuery = '';
let selected = -1;
let disposed = false;
const suggestionIds = new WeakMap<BrowserHistoryEntry, Map<string, string>>();
let nextSuggestionId = 0;

function suggestionId({ entry, url }: BrowserAddressSuggestion): string {
  let ids = suggestionIds.get(entry);
  if (ids === undefined) {
    ids = new Map();
    suggestionIds.set(entry, ids);
  }
  let id = ids.get(url);
  if (id === undefined) {
    id = `history-${nextSuggestionId++}`;
    ids.set(url, id);
  }
  return id;
}

function queryFragmentRanges(source: string, { display, elisions }: BrowserSuggestionClip, terms: string): BrowserTextRange[] {
  if (display === source || elisions.length === 0) return [];
  const ranges: BrowserTextRange[] = [];
  let cursor = 0;
  for (const boundary of [...elisions, display.length]) {
    const range = findBrowserCommonRange(display.slice(cursor, boundary), terms);
    if (range !== undefined && range.end - range.start >= 8) ranges.push({ start: cursor + range.start, end: cursor + range.end });
    cursor = boundary + 1;
  }
  return ranges;
}

function emphasisRanges(source: string, clip: BrowserSuggestionClip, terms: string): BrowserTextRange[] {
  const sorted = [...findBrowserTextMatches(clip.display, terms), ...queryFragmentRanges(source, clip, terms)].sort((a, b) => a.start - b.start);
  const merged: BrowserTextRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged.slice(0, 64);
}

function boundedQueryTerms(): string {
  return browserQueryTerms(foldBrowserText(suggestionQuery)).join(' ').slice(0, 1024);
}

const registration: BrowserOverlayMenuRegistration = {
  id: `browser.address.${randomUUID()}`,
  width: 360,
  placement: 'bottom-start',
  preserveFocus: true,
  onClose: ({ reason }) => {
    if (reason === 'action' || reason === 'escape') return;
    if (reason === 'window-blur' || !document.hasFocus() || document.activeElement !== input.value?.el) {
      clearFocus();
    }
  },
  items: () => {
    const visible = browserSuggestionVisibleChars(registration.width ?? 360);
    const terms = boundedQueryTerms();
    const descriptions = distinguishBrowserSuggestionUrls(suggestions.map((suggestion) => suggestion.url), visible, terms);
    return suggestions.map((suggestion, index) => {
      const { entry } = suggestion;
      const title = suggestion.title || entry.title || suggestion.url;
      const label = clipBrowserSuggestionDisplay(title, Math.min(256, visible), terms);
      const description = clipBrowserSuggestionDisplay(descriptions[index]!, Math.min(1024, visible), terms, browserSuggestionDisplayDifference(descriptions, index), 1024);
      return {
        kind: 'item' as const, id: suggestionId(suggestion), label: label.display, description: description.display, favicon: entry.favicon, icon: 'history', selected: selected === index,
        labelRanges: emphasisRanges(title, label, terms), descriptionRanges: emphasisRanges(descriptions[index]!, description, terms),
      };
    });
  },
  highlightQuery: () => boundedQueryTerms(),
  onSelect: (id) => {
    const suggestion = suggestions.find((candidate) => suggestionId(candidate) === id);
    if (suggestion !== undefined) navigate(suggestion.url);
  },
};
const menu = registerBrowserOverlayMenu(registration);

function showSuggestions(value: string): void {
  if (!focused.value || root.value === undefined || history === null) return;
  if (historyGroups?.history !== history) historyGroups = { history, groups: groupBrowserHistorySuggestions(history) };
  suggestionQuery = value.trim();
  suggestions = matchBrowserHistorySuggestions(historyGroups.groups, suggestionQuery, 8);
  selected = -1;
  if (suggestions.length === 0) { menu.close(); return; }
  if (menu.open.value && !menu.closing.value) menu.refresh();
  else resizeSuggestions();
}

function resizeSuggestions(): void {
  if (root.value === undefined) return;
  registration.width = Math.max(180, Math.round(root.value.getBoundingClientRect().width));
  menu.show(root.value);
}

function update(value: string): void {
  pendingArrowSteps = [];
  emit('update:modelValue', value);
  if (history === null) void requestSuggestions();
  else showSuggestions(value);
}

function navigate(value: string): void {
  menu.close();
  selected = -1;
  pendingArrowSteps = [];
  emit('update:modelValue', value);
  emit('navigate');
}

function loadHistory(): Promise<BrowserHistoryEntry[] | undefined> {
  if (historyRequest !== null) return historyRequest;
  const request = Promise.resolve(getNativeBrowserBridge()?.browserGetData()).then((data) => {
    if (disposed) return undefined;
    history = data?.history ?? [];
    return history;
  }).catch(() => undefined).finally(() => { if (historyRequest === request) historyRequest = null; });
  historyRequest = request;
  return request;
}

let requestSerial = 0;

async function requestSuggestions(): Promise<void> {
  const serial = ++requestSerial;
  const data = await menu.request(loadHistory);
  if (data === undefined || disposed || !focused.value) {
    if (serial === requestSerial) pendingArrowSteps = [];
    return;
  }
  showSuggestions(props.modelValue);
  if (pendingArrowSteps.length > 0 && menu.open.value) {
    for (const step of pendingArrowSteps) {
      selected = nextBrowserMenuIndex(selected, suggestions.length, step);
    }
    menu.refresh();
  }
  pendingArrowSteps = [];
}

function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || (isMacosDesktop && event.ctrlKey)) {
    pendingArrowSteps = [];
    menu.close();
    return;
  }
  if (focused.value) {
    if (event.target !== input.value?.el) return;
    pendingArrowSteps = [];
    if (history === null) void requestSuggestions();
    else showSuggestions(props.modelValue);
    return;
  }
  pointerFocus = true;
}

function onPointerRelease(): void {
  pointerFocus = false;
}

async function onFocus(): Promise<void> {
  if (focused.value) return;
  focused.value = true;
  history = null;
  emit('focus');
  input.value?.select();
  if (pointerFocus) {
    pointerFocus = false;
    await requestSuggestions();
  }
}

function onBlur(event: FocusEvent): void {
  if (event.relatedTarget === null && menu.open.value) return;
  if (event.relatedTarget instanceof Node) menu.close();
  clearFocus();
}

function clearFocus(): void {
  pointerFocus = false;
  pendingArrowSteps = [];
  if (!focused.value) return;
  focused.value = false;
  emit('blur');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    navigate(menu.open.value && selected >= 0 ? suggestions[selected]?.url ?? props.modelValue : props.modelValue);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    menu.close();
    selected = -1;
    pendingArrowSteps = [];
    emit('update:modelValue', props.url);
    input.value?.select();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1;
    if (history === null) {
      event.preventDefault();
      pendingArrowSteps.push(step);
      void requestSuggestions();
      return;
    }
    if (!menu.open.value || menu.closing.value) showSuggestions(props.modelValue);
    if (suggestions.length === 0) return;
    event.preventDefault();
    selected = nextBrowserMenuIndex(selected, suggestions.length, step);
    menu.refresh();
  }
}

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  resizeObserver = new ResizeObserver(() => { if (menu.open.value) resizeSuggestions(); });
  if (root.value !== undefined) resizeObserver.observe(root.value);
  document.addEventListener('pointerup', onPointerRelease, true);
  document.addEventListener('pointercancel', onPointerRelease, true);
});
onUnmounted(() => {
  disposed = true;
  resizeObserver?.disconnect();
  document.removeEventListener('pointerup', onPointerRelease, true);
  document.removeEventListener('pointercancel', onPointerRelease, true);
  menu.dispose();
});
function focusProgrammatic(): void {
  pointerFocus = false;
  selected = -1;
  pendingArrowSteps = [];
  menu.close();
  input.value?.focus();
}
defineExpose({ focus: focusProgrammatic, select: () => input.value?.select() });
</script>

<template>
  <div ref="root" class="browser-address" :class="{ 'is-focused': focused }" @mousedown="onMouseDown">
    <slot name="site"><Icon name="globe" size="sm" /></slot>
    <Input ref="input" :model-value="modelValue" embedded size="sm" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="menu.open.value" :aria-label="t('browser.addressAria')" :placeholder="t('browser.addressPlaceholder')" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="update" @focus="onFocus" @blur="onBlur" @keydown="onKeydown" />
  </div>
</template>

<style scoped>
.browser-address {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-inline: var(--space-1) var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}
.browser-address:focus-within {
  background: var(--color-bg);
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
</style>
