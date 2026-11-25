<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue';
import { Button, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';
import type { CreateCardActionId, CreateDecisionCardView } from './createPresentation';

const props = defineProps<{
  view: CreateDecisionCardView;
  busyAction?: CreateCardActionId | null;
}>();

const emit = defineEmits<{
  action: [id: CreateCardActionId];
}>();

function run(id: CreateCardActionId): void {
  if (props.busyAction !== null && props.busyAction !== undefined) return;
  emit('action', id);
}

const { isComposingKeyEvent } = useImeComposition();

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.repeat || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isComposingKeyEvent(event)) return;
  if (openDialogCount.value > 0) return;
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
  <div class="appr wcc" :data-worktree-card="view.kind" role="group" :aria-label="view.title">
    <div class="ah">
      <span class="adot" aria-hidden="true" />
      <span class="akind">{{ view.title }}</span>
    </div>
    <div class="ab">
      <p class="wcc-text">{{ view.body }}</p>
      <ul v-if="view.files.length > 0" class="wcc-files">
        <li v-for="file in view.files" :key="file" class="wcc-file">{{ file }}</li>
      </ul>
    </div>
    <div class="af">
      <div class="abtns">
        <Button
          v-for="item in view.actions"
          :key="item.id"
          :class="{ amain: item.primary }"
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
    </div>
  </div>
</template>

<style scoped src="../lib/dock-card.css"></style>
<style scoped>
.wcc {
  margin: var(--space-2) var(--dock-inline-right, 16px) 0 var(--dock-inline-left, 16px);
  font-family: var(--font-ui);
}
.wcc-text {
  margin: 0;
  color: var(--color-text);
  font: var(--text-base) / var(--leading-normal) var(--font-ui);
  overflow-wrap: anywhere;
}
.wcc-files {
  max-height: 160px;
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--color-well);
  color: var(--color-text-muted);
  font: var(--content-font-size) / 1.571 var(--font-mono);
  list-style: none;
  user-select: text;
}
.wcc-file {
  overflow-wrap: anywhere;
}
</style>
