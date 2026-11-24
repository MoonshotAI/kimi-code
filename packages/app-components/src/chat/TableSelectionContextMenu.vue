<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWarningsStore } from '@moonshot-ai/app-client/stores';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { selectEntireTable, tableSelectionText, type TableCopyFormat } from '@moonshot-ai/app-markdown';
import { Icon, Menu, MenuItem, menuNavigationIndex } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

withDefaults(defineProps<{ allowQuote?: boolean }>(), { allowQuote: true });
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

async function show(wrapper: HTMLElement, x: number, y: number): Promise<void> {
  preserveEditorFocus = false;
  currentWrapper.value = wrapper;
  closeFormats();
  await menu.openAt(x, y);
  await nextTick();
  enabledItems(menuRef.value?.el)[0]?.focus();
}

async function copy(format: TableCopyFormat): Promise<void> {
  const wrapper = currentWrapper.value;
  menu.close();
  closeFormats();
  if (!wrapper) return;
  const text = tableSelectionText(wrapper, format);
  if (text === null) return;
  const ok = await copyTextToClipboard(text);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
}

function selectAll(): void {
  const wrapper = currentWrapper.value;
  menu.close();
  closeFormats();
  if (wrapper) selectEntireTable(wrapper);
}

function addToChat(): void {
  preserveEditorFocus = true;
  const wrapper = currentWrapper.value;
  menu.close();
  closeFormats();
  if (!wrapper) return;
  const markdown = tableSelectionText(wrapper, 'markdown');
  if (markdown !== null) emit('quote', markdown);
}

defineExpose({ show, close: menu.close });
</script>

<template>
  <Teleport to="body">
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
