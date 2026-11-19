<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';
import type { CreateCardActionId, CreateDecisionCardView } from './createPresentation';

const props = defineProps<{
  view: CreateDecisionCardView;
  busyAction?: CreateCardActionId | null;
}>();

const emit = defineEmits<{
  action: [id: CreateCardActionId];
}>();

const { t } = useI18n();
const minimized = ref(false);

watch(
  () => props.view.kind,
  () => {
    minimized.value = false;
  },
);

function run(id: CreateCardActionId): void {
  if (props.busyAction !== null && props.busyAction !== undefined) return;
  emit('action', id);
}

const { isComposingKeyEvent } = useImeComposition();

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.repeat || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isComposingKeyEvent(event)) return;
  if (minimized.value || openDialogCount.value > 0) return;
  const active = document.activeElement;
  const tag = (active?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || (active instanceof HTMLElement && active.isContentEditable)) return;
  if (active?.closest('button, a[href], select, summary, [role="button"]')) return;
  const primary = props.view.actions.find((item) => item.primary === true);
  if (primary === undefined) return;
  event.preventDefault();
  run(primary.id);
}

onMounted(() => document.addEventListener('keydown', handleKeydown, true));
onActivated(() => document.addEventListener('keydown', handleKeydown, true));
onDeactivated(() => document.removeEventListener('keydown', handleKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown, true));
</script>

<template>
  <div class="wcc" :class="{ minimized }" :data-worktree-card="view.kind" role="group" :aria-label="view.title">
    <div class="wcc-head" :class="{ clickable: minimized }" @click="minimized = false">
      <span class="wcc-dot" aria-hidden="true" />
      <span class="wcc-title">{{ view.title }}</span>
      <IconButton
        class="wcc-min"
        size="sm"
        :label="minimized ? t('worktreeCreate.card.expand') : t('worktreeCreate.card.minimize')"
        :tooltip="minimized ? t('worktreeCreate.card.expand') : t('worktreeCreate.card.minimize')"
        @click.stop="minimized = !minimized"
      >
        <Icon :name="minimized ? 'chevron-up' : 'minus'" size="md" />
      </IconButton>
    </div>
    <template v-if="!minimized">
      <div class="wcc-body">
        <p class="wcc-text">{{ view.body }}</p>
        <ul v-if="view.files.length > 0" class="wcc-files">
          <li v-for="file in view.files" :key="file" class="wcc-file">{{ file }}</li>
        </ul>
        <pre v-if="view.code" class="wcc-code">{{ view.code }}</pre>
      </div>
      <div class="wcc-actions">
        <Button
          v-for="item in view.actions"
          :key="item.id"
          :variant="item.primary ? 'primary' : 'secondary'"
          :keys="item.primary ? ['enter'] : []"
          :loading="busyAction === item.id"
          :disabled="busyAction !== null && busyAction !== undefined"
          :data-action="item.id"
          @click="run(item.id)"
        >
          {{ item.label }}
        </Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wcc {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
  margin: var(--space-2) var(--dock-inline-right, 16px) 0 var(--dock-inline-left, 16px);
  overflow: hidden auto;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-2xl);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-input);
  font-family: var(--font-ui);
  animation: kimi-card-in var(--duration-base) var(--ease-out);
  container-type: inline-size;
}
.wcc.minimized {
  transition: background var(--duration-fast) var(--ease-out);
}
.wcc.minimized:hover {
  background: var(--color-hover);
}
.wcc-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: var(--space-4) var(--space-4) 0;
}
.wcc.minimized .wcc-head {
  padding-bottom: var(--space-3);
}
.wcc-head.clickable {
  cursor: pointer;
}
.wcc-dot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}
.wcc-dot::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-attention);
}
.wcc-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcc-min {
  flex: none;
  margin-left: auto;
}
.wcc-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-2) var(--space-4) 0;
}
.wcc-text {
  margin: 0;
  color: var(--color-text);
  font: var(--text-base) / var(--leading-normal) var(--font-ui);
  overflow-wrap: anywhere;
}
.wcc-files,
.wcc-code {
  max-height: 160px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--color-well);
  color: var(--color-text-muted);
  font: var(--content-font-size) / 1.571 var(--font-mono);
  user-select: text;
}
.wcc-files {
  list-style: none;
}
.wcc-file {
  overflow-wrap: anywhere;
}
.wcc-code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wcc-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: 10px;
  padding: 0 var(--space-4) var(--space-4);
}
@container (max-width: 480px) {
  .wcc-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .wcc-actions > :deep(.ui-button) {
    width: 100%;
    min-width: 0;
    white-space: normal;
  }
}
</style>
