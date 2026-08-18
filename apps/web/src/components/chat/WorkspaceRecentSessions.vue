<!-- apps/web/src/components/chat/WorkspaceRecentSessions.vue -->
<!-- The workspace home's recent-sessions list (below the centred composer):
     the draft workspace's open sessions first, then its done ones, capped by
     the facade. Rows carry the status view's Open/Done tag; click selects
     the session. Display-only rows — row-level actions stay in the sidebar.
     (The desktop build's list foot links to its session admin page; web has
     no admin page, so the foot is omitted.) -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { Session } from '../../types';

defineProps<{
  sessions: Session[];
}>();

const emit = defineEmits<{
  selectSession: [id: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="wrs">
    <div class="wrs-caption">{{ t('conversation.recentSessions') }}</div>
    <button
      v-for="s in sessions"
      :key="s.id"
      type="button"
      class="wrs-row"
      @click="emit('selectSession', s.id)"
    >
      <span class="wrs-ico" :class="s.archived ? 'wrs-ico--done' : 'wrs-ico--open'">
        <Icon :name="s.archived ? 'state-done' : 'state-open'" size="sm" />
      </span>
      <span class="wrs-title">{{ s.title }}</span>
      <span class="wrs-time">{{ s.time }}</span>
    </button>
  </div>
</template>

<style scoped>
.wrs {
  flex: none;
  display: flex;
  flex-direction: column;
  /* Align with the composer card above: same inline insets as .composer's
     own padding (16px fallback when the dock vars are unset). */
  margin: var(--space-4) var(--dock-inline-right, 16px) 0 var(--dock-inline-left, 16px);
}
.wrs-caption {
  padding: 0 var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}
.wrs-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: 6px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.wrs-row:hover {
  background: var(--color-hover);
}
.wrs-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
/* The status view's Open/Done state glyph — colored icon, no chip (same
   language as the sidebar session row's). */
.wrs-ico {
  display: inline-flex;
  flex: none;
}
.wrs-ico--open {
  color: var(--color-success);
}
.wrs-ico--done {
  color: var(--color-done);
}
.wrs-title {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wrs-time {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
</style>
