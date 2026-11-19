<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { menuNavigationIndex, Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

const props = defineProps<{ items: Array<{ id: string; label: string; icon?: string; disabled?: boolean }> }>();
const hasIcons = computed(() => props.items.some(item => item.icon !== undefined));
const emit = defineEmits<{ select: [id: string] }>();
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menu = useAnchoredMenu(menuRef);
let returnFocus: HTMLElement | undefined;
async function show(x: number, y: number, trigger: HTMLElement | undefined, keyboard: boolean): Promise<void> {
  returnFocus = trigger;
  await menu.openAt(x, y);
  if (keyboard) enabledItems()[0]?.focus();
}
function enabledItems(): HTMLElement[] {
  return [...(menuRef.value?.el?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? [])];
}
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    menu.close();
    returnFocus?.focus();
    return;
  }
  const items = enabledItems();
  const next = menuNavigationIndex(event.key, event.shiftKey, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}
function select(id: string): void {
  menu.close();
  emit('select', id);
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
}
defineExpose({ show, close: menu.close });
</script>
<template>
  <Teleport to="body">
    <Transition name="menu-pop">
      <Menu v-if="menu.open.value" ref="menuRef" class="panel-context-menu" :style="menu.menuStyle.value" @keydown="onKeydown">
        <MenuItem v-for="item in items" :key="item.id" :disabled="item.disabled" @click="select(item.id)">
          <Icon v-if="item.icon" :name="item.icon" />
          <span v-else-if="hasIcons" class="panel-menu-icon-space" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </MenuItem>
      </Menu>
    </Transition>
  </Teleport>
</template>
<style scoped>
.panel-menu-icon-space {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
}
.panel-context-menu {
  user-select: none;
  position: fixed;
  z-index: var(--z-dropdown);
  max-height: calc(100vh - var(--space-4));
  overflow-y: auto;
}
</style>
