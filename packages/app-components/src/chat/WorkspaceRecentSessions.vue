<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';

defineProps<{
  sessions: Session[];
}>();

const client = useKimiWebClient();

const { t } = useI18n();

function selectSession(id: string): void {
  void client.selectSession(id);
}

function openSessionAdmin(): void {
  client.openSessionAdmin(client.activeWorkspaceId.value ?? undefined);
}
</script>

<template>
  <div class="wrs">
    <div class="wrs-caption">{{ t('conversation.recentSessions') }}</div>
    <button
      v-for="s in sessions"
      :key="s.id"
      type="button"
      class="wrs-row"
      @click="selectSession(s.id)"
    >
      <span class="wrs-ico" :class="s.archived ? 'wrs-ico--done' : 'wrs-ico--open'">
        <Icon :name="s.archived ? 'state-done' : 'state-open'" size="sm" />
      </span>
      <span class="wrs-title">{{ s.title }}</span>
      <span class="wrs-time">{{ s.time }}</span>
    </button>
    <div class="wrs-foot">
      <Tooltip :text="t('conversation.sessionAdminTooltip')">
        <button type="button" class="wrs-more" @click="openSessionAdmin">
          {{ t('conversation.viewMoreSessions') }}
          <Icon name="chevron-down" size="sm" />
        </button>
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.wrs {
  flex: none;
  display: flex;
  flex-direction: column;
  margin: var(--space-4) var(--dock-inline-right, 16px) 0 var(--dock-inline-left, 16px);
}
.wrs-caption {
  padding: 0 var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--color-text-quaternary);
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
  font-size: var(--text-sm);
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
.wrs-foot {
  display: flex;
  justify-content: center;
  margin-top: var(--space-2);
}
.wrs-more {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.wrs-more:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.wrs-more svg {
  color: var(--color-text-faint);
}
</style>
