<!-- The session admin table's action menus, one component three shapes
     (prototype-faithful):
       single      row contextmenu — Open session / Rename… / Fork / Export,
                   separator, Mark as done|Reopen (whichever applies)
       rowActions  the ⋯ dropdown — Rename… / Fork / Export
       multi       contextmenu inside a multi-selection — a count head plus
                   Mark as done (n) / Reopen (n), disabled per availability
     Positioning comes from useAnchoredMenu (raw point for contextmenu,
     right-edge anchored for the ⋯ trigger); the surface is app-ui Menu. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '@moonshot-ai/app-components';

export type SessionAdminMenuMode = 'single' | 'rowActions' | 'multi';

export type SessionAdminMenuAction =
  | 'open'
  | 'rename'
  | 'fork'
  | 'export'
  | 'archive'
  | 'restore';

defineProps<{
  mode: SessionAdminMenuMode;
  /** single / rowActions: the target row's lifecycle (which action to show). */
  targetArchived?: boolean;
  /** multi: the selection's composition (head count + per-action disables). */
  counts?: { total: number; open: number; done: number };
}>();

const emit = defineEmits<{ action: [action: SessionAdminMenuAction] }>();

const { t } = useI18n();
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, toggleAnchored, openAt, close } = useAnchoredMenu(menuRef);

function act(action: SessionAdminMenuAction): void {
  close();
  emit('action', action);
}

defineExpose({ openAt, toggleAnchored, close });
</script>

<template>
  <Transition name="menu-pop">
    <Menu v-if="open" ref="menuRef" class="sa-menu" :style="menuStyle" @click.stop>
      <template v-if="mode === 'single'">
        <MenuItem @click="act('open')">
          <Icon name="external-link" size="sm" />
          {{ t('admin.open') }}
        </MenuItem>
        <MenuItem @click="act('rename')">
          <Icon name="pencil" size="sm" />
          {{ t('admin.rename') }}
        </MenuItem>
        <MenuItem @click="act('fork')">
          <Icon name="git-fork" size="sm" />
          {{ t('admin.fork') }}
        </MenuItem>
        <MenuItem @click="act('export')">
          <Icon name="download" size="sm" />
          {{ t('admin.export') }}
        </MenuItem>
        <MenuItem separator />
        <MenuItem v-if="targetArchived" @click="act('restore')">
          <Icon name="undo" size="sm" />
          {{ t('admin.reopen') }}
        </MenuItem>
        <MenuItem v-else @click="act('archive')">
          <Icon name="state-done" size="sm" />
          {{ t('admin.markDone') }}
        </MenuItem>
      </template>

      <template v-else-if="mode === 'rowActions'">
        <MenuItem @click="act('rename')">
          <Icon name="pencil" size="sm" />
          {{ t('admin.rename') }}
        </MenuItem>
        <MenuItem @click="act('fork')">
          <Icon name="git-fork" size="sm" />
          {{ t('admin.fork') }}
        </MenuItem>
        <MenuItem @click="act('export')">
          <Icon name="download" size="sm" />
          {{ t('admin.export') }}
        </MenuItem>
      </template>

      <template v-else>
        <div class="sa-menu-head">
          {{ t('admin.batchSelected', { n: counts?.total ?? 0 }) }}
        </div>
        <MenuItem :disabled="(counts?.open ?? 0) === 0" @click="act('archive')">
          <Icon name="state-done" size="sm" />
          {{ t('admin.markDoneCount', { n: counts?.open ?? 0 }) }}
        </MenuItem>
        <MenuItem :disabled="(counts?.done ?? 0) === 0" @click="act('restore')">
          <Icon name="undo" size="sm" />
          {{ t('admin.reopenCount', { n: counts?.done ?? 0 }) }}
        </MenuItem>
      </template>
    </Menu>
  </Transition>
</template>

<style scoped>
.sa-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* Multi-shape head: a muted selection count above the two batch actions. */
.sa-menu-head {
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  user-select: none;
}

/* Menu enter/exit — pops out of the anchor corner (Sidebar menu language). */
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
