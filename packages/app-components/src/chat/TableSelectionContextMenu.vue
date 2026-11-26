<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWarningsStore } from '@moonshot-ai/app-client/stores';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';
import { selectEntireTable, tableSelectionText, type TableCopyFormat } from '@moonshot-ai/app-markdown';
import { Icon, Menu, MenuItem, menuNavigationIndex } from '@moonshot-ai/app-ui';
import { useNativeMenuHost } from '../composer/nativeMenus';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

let tableMenuSequence = 0;

const props = withDefaults(defineProps<{ allowQuote?: boolean }>(), { allowQuote: true });
const emit = defineEmits<{ quote: [markdown: string] }>();
const { t } = useI18n();
const warningsStore = useWarningsStore();
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const subMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const formatsAnchorRef = ref<HTMLElement | null>(null);
const menu = useAnchoredMenu(menuRef, subMenuRef);
const subMenuStyle = ref<Record<string, string>>({});
const formatsOpen = ref(false);
const currentWrapper = ref<HTMLElement | null>(null);
let preserveEditorFocus = false;
const formats: Array<{ id: TableCopyFormat; label: string }> = [
  { id: 'tsv', label: 'TSV' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
];

function closeFormats(): void {
  formatsOpen.value = false;
}

function restoreWrapperFocus(): void {
  if (preserveEditorFocus) return;
  const wrapper = currentWrapper.value;
  if (!wrapper) return;
  window.requestAnimationFrame(() => {
    if (!preserveEditorFocus && currentWrapper.value === wrapper) wrapper.focus({ preventScroll: true });
  });
}

watch(() => menu.open.value, (open) => {
  closeFormats();
  if (!open && !preserveEditorFocus) currentWrapper.value?.focus({ preventScroll: true });
});

async function openFormats(focusFirst = false): Promise<void> {
  formatsOpen.value = true;
  await nextTick();
  const anchor = formatsAnchorRef.value;
  const submenu = subMenuRef.value?.el;
  if (!anchor || !submenu) return;
  const rect = anchor.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const width = submenu.offsetWidth;
  const height = submenu.offsetHeight;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, rect.left - width - gap);
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  let top = rect.top - gap;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  subMenuStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
  if (focusFirst) submenu.querySelector<HTMLElement>('.ui-menu-item:not(:disabled)')?.focus();
}

function enabledItems(container: HTMLElement | undefined): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? [])];
}

function moveFocus(container: HTMLElement | undefined, event: KeyboardEvent): void {
  const items = enabledItems(container);
  const next = menuNavigationIndex(event.key, event.shiftKey, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus();
}

function onParentKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight' && (event.target as Element).closest('.table-copy-formats')) {
    event.preventDefault();
    event.stopPropagation();
    void openFormats(true);
    return;
  }
  moveFocus(menuRef.value?.el, event);
}

function onSubmenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    event.stopPropagation();
    closeFormats();
    formatsAnchorRef.value?.querySelector<HTMLElement>('.ui-menu-item')?.focus();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFormats();
    formatsAnchorRef.value?.querySelector<HTMLElement>('.ui-menu-item')?.focus();
    return;
  }
  moveFocus(subMenuRef.value?.el, event);
}

function nativeItems(): NativeMenuItem[] {
  return [
    { kind: 'item', id: 'copy', label: t('conversation.copyTableSelection'), icon: 'copy' },
    {
      kind: 'item',
      id: 'copy-as',
      label: t('conversation.copyTableSelectionAs'),
      icon: 'copy',
      keepOpen: true,
      submenu: formats.map(format => ({ id: `copy-as-${format.id}`, label: format.label })),
    },
    { kind: 'item', id: 'select-all', label: t('conversation.selectWholeTable'), icon: 'grid-dots' },
    ...(props.allowQuote ? [{ kind: 'item' as const, id: 'add-to-chat', label: t('selection.addToChat'), icon: 'plus' }] : []),
  ];
}

async function copy(format: TableCopyFormat): Promise<void> {
  const wrapper = currentWrapper.value;
  const native = nativeMenu?.available === true;
  closeMenu();
  if (!wrapper) return;
  const text = tableSelectionText(wrapper, format);
  if (text === null) return;
  const ok = await copyTextToClipboard(text);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
  if (native) restoreWrapperFocus();
}

function selectAll(): void {
  const wrapper = currentWrapper.value;
  const native = nativeMenu?.available === true;
  closeMenu();
  if (!wrapper) return;
  selectEntireTable(wrapper);
  if (native) restoreWrapperFocus();
}

function addToChat(): void {
  preserveEditorFocus = true;
  const wrapper = currentWrapper.value;
  closeMenu();
  if (!wrapper) return;
  const markdown = tableSelectionText(wrapper, 'markdown');
  if (markdown !== null) emit('quote', markdown);
}

const nativeMenu = useNativeMenuHost()?.register({
  id: `table-selection-${++tableMenuSequence}`,
  autoWidth: true,
  placement: 'bottom-start',
  items: nativeItems,
  onSelect: (id) => {
    if (id === 'copy') void copy('tsv');
    else if (id.startsWith('copy-as-')) void copy(id.slice('copy-as-'.length) as TableCopyFormat);
    else if (id === 'select-all') selectAll();
    else if (id === 'add-to-chat') addToChat();
  },
});

function closeMenu(): void {
  menu.close();
  nativeMenu?.close();
  closeFormats();
}

async function show(wrapper: HTMLElement, x: number, y: number, keyboard = false): Promise<void> {
  preserveEditorFocus = false;
  currentWrapper.value = wrapper;
  closeFormats();
  const initialFocus = keyboard ? 'first-item' : 'none';
  if (nativeMenu?.available) {
    menu.close();
    nativeMenu.showAt(
      { x, y, width: 0, height: 0 },
      { placement: 'bottom-start', offset: 0, initialFocus, focusReturn: wrapper },
    );
    return;
  }
  await menu.openAt(x, y);
  if (!keyboard) return;
  await nextTick();
  enabledItems(menuRef.value?.el)[0]?.focus();
}

defineExpose({ show, close: closeMenu });
</script>

<template>
  <Teleport v-if="!nativeMenu?.available" to="body">
    <Menu
      v-if="menu.open.value"
      ref="menuRef"
      class="ui-menu-floating table-selection-context-menu"
      :style="menu.menuStyle.value"
      @click.stop
      @contextmenu.prevent
      @keydown="onParentKeydown"
    >
      <MenuItem @mouseenter="closeFormats" @focusin="closeFormats" @click="copy('tsv')">
        <Icon name="copy" size="sm" />
        {{ t('conversation.copyTableSelection') }}
      </MenuItem>
      <div ref="formatsAnchorRef" class="table-copy-formats" @mouseenter="openFormats()">
        <MenuItem
          :active="formatsOpen"
          has-popup="menu"
          :expanded="formatsOpen"
          @click="openFormats($event.detail === 0)"
        >
          <Icon name="copy" size="sm" />
          {{ t('conversation.copyTableSelectionAs') }}
          <template #action><Icon name="chevron-right" size="sm" /></template>
        </MenuItem>
      </div>
      <MenuItem @mouseenter="closeFormats" @focusin="closeFormats" @click="selectAll">
        <Icon name="grid-dots" size="sm" />
        {{ t('conversation.selectWholeTable') }}
      </MenuItem>
      <MenuItem v-if="allowQuote" @mouseenter="closeFormats" @focusin="closeFormats" @click="addToChat">
        <Icon name="plus" size="sm" />
        {{ t('selection.addToChat') }}
      </MenuItem>
    </Menu>
    <Menu
      v-if="menu.open.value && formatsOpen"
      ref="subMenuRef"
      class="ui-menu-floating table-selection-copy-submenu"
      :style="subMenuStyle"
      @click.stop
      @contextmenu.prevent
      @keydown="onSubmenuKeydown"
    >
      <MenuItem v-for="format in formats" :key="format.id" @click="copy(format.id)">
        {{ format.label }}
      </MenuItem>
    </Menu>
  </Teleport>
</template>

<style scoped>
.table-selection-context-menu,
.table-selection-copy-submenu {
  user-select: none;
  max-height: calc(100vh - var(--space-4));
  overflow-y: auto;
}
.table-selection-copy-submenu {
  z-index: calc(var(--z-dropdown) + 1);
}
</style>
