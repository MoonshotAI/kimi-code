<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from './composables/useAnchoredMenu';
import { useFileTreePosition, type FileTreePosition } from './composables/useFileTreePosition';

const { t } = useI18n();

const { position, setPosition } = useFileTreePosition();

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, toggleAnchored, close } = useAnchoredMenu(menuRef);

function pick(next: FileTreePosition): void {
  setPosition(next);
  close();
}
</script>

<template>
  <div class="ftpm">
    <IconButton
      size="sm"
      :label="t('fileTree.settings')"
      :tooltip="t('fileTree.settings')"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggleAnchored($event, 'right')"
    >
      <Icon name="settings" size="md" />
    </IconButton>
    <Transition name="menu-pop">
      <Menu v-if="open" ref="menuRef" class="ftpm-menu" :style="menuStyle" @click.stop>
        <div class="ftpm-head">{{ t('fileTree.positionTitle') }}</div>
        <MenuItem role="menuitemradio" :aria-checked="position === 'left'" @click="pick('left')">
          <Icon v-if="position === 'left'" name="check" size="sm" />
          <span v-else class="ftpm-check-slot" />
          {{ t('fileTree.positionLeft') }}
        </MenuItem>
        <MenuItem role="menuitemradio" :aria-checked="position === 'right'" @click="pick('right')">
          <Icon v-if="position === 'right'" name="check" size="sm" />
          <span v-else class="ftpm-check-slot" />
          {{ t('fileTree.positionRight') }}
        </MenuItem>
      </Menu>
    </Transition>
  </div>
</template>

<style scoped>
.ftpm-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

.ftpm-head {
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  user-select: none;
}

.ftpm-check-slot {
  width: 16px;
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
