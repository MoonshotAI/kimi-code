<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { basename } from '@moonshot-ai/app-core/lib';
import { Icon, Menu, MenuItem, Tooltip } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from './composables/useAnchoredMenu';

const { t } = useI18n();

defineProps<{
  roots: readonly string[];
  root: string;
}>();

const emit = defineEmits<{
  select: [root: string];
}>();

const rootMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const {
  open: rootMenuOpen,
  menuStyle: rootMenuStyle,
  toggle: toggleRootMenu,
  close: closeRootMenu,
} = useAnchoredMenu(rootMenuRef);

function pickRoot(root: string): void {
  emit('select', root);
  closeRootMenu();
}
</script>

<template>
  <div class="files-root-select-wrap">
    <Tooltip :text="root">
      <button
        type="button"
        class="files-root-select"
        :class="{ 'is-open': rootMenuOpen }"
        :aria-label="t('fileTree.switchRoot')"
        :aria-expanded="rootMenuOpen"
        aria-haspopup="menu"
        @click="toggleRootMenu"
      >
        <Icon name="folder-closed" size="md" />
        <span class="files-root-select-name">{{ basename(root) }}</span>
        <Icon class="files-root-select-chev" name="chevron-down" size="sm" />
      </button>
    </Tooltip>
    <Transition name="menu-pop">
      <Menu v-if="rootMenuOpen" ref="rootMenuRef" class="files-root-menu" :style="rootMenuStyle" @click.stop>
        <MenuItem
          v-for="item in roots"
          :key="item"
          role="menuitemradio"
          :title="item"
          :aria-checked="item === root"
          @click="pickRoot(item)"
        >
          <Icon name="folder-closed" size="sm" />
          <span class="files-root-menu-name">{{ basename(item) }}</span>
          <Icon v-if="item === root" class="files-root-menu-check" name="check" size="sm" />
        </MenuItem>
      </Menu>
    </Transition>
  </div>
</template>

<style scoped>
.files-root-select-wrap {
  display: flex;
  flex: none;
  min-width: 0;
  padding: var(--space-2) var(--space-2) 0;
}

.files-root-select-wrap > :first-child {
  flex: 1;
  min-width: 0;
}

.files-root-select {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 var(--space-1-5);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: var(--weight-semibold) var(--ui-b2) var(--font-ui);
  cursor: pointer;
}

.files-root-select:hover,
.files-root-select.is-open {
  background: var(--color-hover);
}

.files-root-select-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.files-root-select-chev {
  flex: none;
  margin-left: auto;
  color: var(--color-text-faint);
}

.files-root-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

.files-root-menu-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.files-root-menu-check {
  flex: none;
}

.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
