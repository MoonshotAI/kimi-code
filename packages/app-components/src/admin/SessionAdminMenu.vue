<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

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
  targetArchived?: boolean;
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
  <Transition name="ui-menu-pop">
    <Menu v-if="open" ref="menuRef" class="ui-menu-floating sa-menu" :style="menuStyle" @click.stop>
      <template v-if="mode !== 'multi'">
        <MenuItem v-if="mode === 'single'" @click="act('open')">
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
        <template v-if="mode === 'single'">
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
      </template>

      <template v-else>
        <div class="anchored-menu-head">
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

<style src="../lib/anchored-menu.css"></style>
