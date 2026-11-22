<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import type { CreateCardActionId, CreateInvalidCardView } from './createPresentation';
import WorktreeOutput from './WorktreeOutput.vue';

const props = defineProps<{
  view: CreateInvalidCardView;
  busyAction?: CreateCardActionId | null;
}>();

const emit = defineEmits<{
  action: [id: CreateCardActionId];
}>();

const { t } = useI18n();
const outputOpen = ref(false);

watch(
  () => props.view.phase,
  () => {
    outputOpen.value = false;
  },
);

function run(id: CreateCardActionId): void {
  if (id === 'viewOutput') {
    outputOpen.value = !outputOpen.value;
    return;
  }
  if (props.busyAction !== null && props.busyAction !== undefined) return;
  emit('action', id);
}

function labelOf(id: CreateCardActionId, label: string): string {
  return id === 'viewOutput' && outputOpen.value ? t('worktreeCreate.action.hideOutput') : label;
}
</script>

<template>
  <div class="wci" :data-worktree-invalid="view.phase" role="group" :aria-label="view.title">
    <div class="wci-row">
      <span class="wci-tile" aria-hidden="true">
        <Spinner v-if="view.phase === 'recreating'" size="sm" />
        <Icon v-else name="git-fork-off" size="md" />
      </span>
      <div class="wci-copy">
        <div class="wci-title" role="status">{{ view.title }}</div>
        <div v-if="view.body" class="wci-body">{{ view.body }}</div>
        <div v-if="view.command" class="wci-command" :title="view.command">{{ view.command }}</div>
      </div>
      <div class="wci-actions">
        <Button
          v-for="item in view.actions"
          :key="item.id"
          size="sm"
          :variant="item.id === 'viewOutput' ? 'text' : 'secondary'"
          :loading="busyAction === item.id"
          :disabled="item.id !== 'viewOutput' && busyAction !== null && busyAction !== undefined"
          :aria-expanded="item.id === 'viewOutput' ? outputOpen : undefined"
          :data-action="item.id"
          @click="run(item.id)"
        >
          {{ labelOf(item.id, item.label) }}
        </Button>
      </div>
    </div>
    <WorktreeOutput v-if="outputOpen && view.output" class="wci-output" :text="view.output" />
  </div>
</template>

<style scoped>
.wci {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-2) var(--dock-inline-right, 16px) 14px var(--dock-inline-left, 16px);
  padding: var(--space-3);
  border: var(--p-hairline) solid var(--color-warning-bd);
  border-radius: var(--radius-xl);
  background: var(--color-warning-soft);
  font-family: var(--font-ui);
  animation: kimi-card-in var(--duration-base) var(--ease-out);
  container-type: inline-size;
}
.wci-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.wci-tile {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-warning);
}
.wci-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wci-title {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.wci-body {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.wci-command {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.wci-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
@container (max-width: 520px) {
  .wci-row {
    flex-wrap: wrap;
  }
  .wci-copy {
    flex-basis: calc(100% - 28px - var(--space-3));
  }
  .wci-actions {
    flex: 1 1 100%;
  }
}
</style>
