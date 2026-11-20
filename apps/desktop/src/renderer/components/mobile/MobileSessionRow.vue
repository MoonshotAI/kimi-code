<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Session } from '../../types';
import { Icon, IconButton, Menu, MenuItem } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{
  session: Session;
  active: boolean;
  attention: number;
  menuOpen: boolean;
  flat?: boolean;
}>(), {
  flat: false,
});

const emit = defineEmits<{
  select: [id: string];
  toggleMenu: [id: string];
  rename: [session: Session];
  archive: [id: string];
  delete: [id: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div
    class="srow"
    :class="{ cur: props.active, 'srow-flat': props.flat }"
    @click="emit('select', props.session.id)"
  >
    <span :class="props.flat ? 'srow-main' : undefined">
      <span
        class="t text-row-label"
        :class="{
          run: props.session.busy,
          aborted: !props.session.busy && props.attention === 0 && props.session.lastTurnReason === 'failed',
        }"
      >{{ props.session.title }}</span>
      <span v-if="props.flat" class="srow-sub">{{ props.session.workspaceName ?? props.session.cwdLabel ?? '-' }}</span>
    </span>
    <span v-if="props.attention > 0" class="att">{{ props.attention }}</span>
    <span class="time">{{ props.session.time }}</span>
    <IconButton
      size="lg"
      class="kb"
      :label="t('sidebar.options')"
      @click.stop="emit('toggleMenu', props.session.id)"
    >
      <Icon name="dots-horizontal" size="md" />
    </IconButton>

    <Menu v-if="props.menuOpen" class="kmenu" @click.stop>
      <MenuItem size="lg" @click="emit('rename', props.session)">{{ t('sidebar.rename') }}</MenuItem>
      <MenuItem size="lg" @click="emit('archive', props.session.id)">{{ t('sidebar.archive') }}</MenuItem>
      <MenuItem separator />
      <MenuItem size="lg" danger @click="emit('delete', props.session.id)"><Icon name="trash" size="sm" /> {{ t('sidebar.delete') }}</MenuItem>
    </Menu>
  </div>
</template>

<style scoped>
.srow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  margin: 1px var(--space-2);
  padding: 0 calc(var(--m-pad) - var(--space-2)) 0 calc(var(--m-indent) - var(--space-2));
  border-radius: var(--radius-md);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  position: relative;
}
.srow:hover { background: var(--color-hover); }
.srow:active { background: var(--color-surface-sunken); }
.srow.cur { background: var(--color-accent-soft); box-shadow: inset 0 0 0 1px var(--color-accent-bd); }
.srow .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .t { color: var(--color-accent-hover); }

.srow .t.run { position: relative; }
.srow .t.run::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: mRunPulse 1.4s ease-in-out infinite;
}
@keyframes mRunPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.srow .t.aborted { position: relative; }
.srow .t.aborted::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-danger);
}
.srow .time {
  flex: none;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-faint);
}
.att {
  flex: none;
  font-family: var(--font-mono);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--color-text-on-accent);
  background: var(--color-warning);
  border-radius: var(--radius-full);
  padding: 1px 7px;
}
.srow .kb { flex: none; margin: 0 calc(-1 * var(--space-2)) 0 0; }
.srow .kb:active { color: var(--color-text); background: var(--color-hover); }

.srow-flat { min-height: 52px; }
.srow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srow-main .t { flex: none; }
.srow-sub {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  z-index: var(--z-dropdown);
  min-width: 96px;
  overflow: hidden;
}
</style>
