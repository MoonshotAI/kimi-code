<script setup lang="ts">
import type { ManagedWorkspace } from '../api/types';
import { Avatar, Icon, MenuItem, Spinner } from '@moonshot-ai/app-ui';

const props = withDefaults(
  defineProps<{
    workspace: ManagedWorkspace;
    avatarSrc?: string;
    initial: string;
    subtitle: string;
    tooltip: string;
    disabled?: boolean;
    switching?: boolean;
    role?: 'menuitem' | 'button';
  }>(),
  { role: 'menuitem', disabled: false, switching: false },
);

defineEmits<{
  select: [workspace: ManagedWorkspace];
  mouseenter: [event: MouseEvent];
}>();
</script>

<template>
  <MenuItem
    class="user-menu-ws-item"
    :role="props.role"
    :disabled="props.disabled"
    :title="props.tooltip"
    @mouseenter="$emit('mouseenter', $event)"
    @click="$emit('select', props.workspace)"
  >
    <Avatar
      :src="props.workspace.kind === 'personal' ? props.avatarSrc : undefined"
      size="sm"
      :shape="props.workspace.kind === 'personal' ? 'circle' : 'square'"
      aria-hidden="true"
    >
      <template v-if="props.workspace.kind === 'business' || !props.avatarSrc">
        {{ props.initial }}
      </template>
    </Avatar>
    <span class="user-menu-ws-body">
      <span class="user-menu-ws-name">{{ props.workspace.name }}</span>
      <span class="user-menu-ws-type">{{ props.subtitle }}</span>
    </span>
    <span class="user-menu-ws-status" aria-hidden="true">
      <Spinner v-if="props.switching" size="sm" />
      <Icon v-else-if="props.workspace.current" class="user-menu-ws-check" name="check" size="sm" />
    </span>
  </MenuItem>
</template>

<style scoped>
.user-menu-ws-item {
  min-height: 50px;
  padding-top: 6px;
  padding-bottom: 6px;
  gap: var(--space-2);
}
.user-menu-ws-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.user-menu-ws-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  line-height: 18px;
  color: var(--color-text);
}
.user-menu-ws-type {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  line-height: 18px;
  color: var(--color-text-faint);
}
.user-menu-ws-status {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.user-menu-ws-item :deep(.user-menu-ws-check) {
  color: var(--color-text);
}
</style>
