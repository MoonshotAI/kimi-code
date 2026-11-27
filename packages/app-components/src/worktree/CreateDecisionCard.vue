<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Spinner, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';
import type { CreateCardActionId, CreateCardView } from './createPresentation';
import WorktreeCommand from './WorktreeCommand.vue';
import WorktreeOutput from './WorktreeOutput.vue';

const props = defineProps<{
  view: CreateCardView;
  busyAction?: CreateCardActionId | null;
}>();

const emit = defineEmits<{
  action: [id: CreateCardActionId];
}>();

const { t } = useI18n();
const kind = computed(() => ('kind' in props.view ? props.view.kind : undefined));
const phase = computed(() => ('phase' in props.view ? props.view.phase : undefined));
const outputOpen = ref(false);

watch([kind, phase], () => {
  outputOpen.value = false;
});

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
  <div
    class="appr wcc"
    :data-worktree-card="kind"
    :data-worktree-invalid="phase"
    role="group"
    :aria-label="view.title"
  >
    <div class="ah">
      <span v-if="phase === 'recreating'" class="adot wcc-spin" aria-hidden="true"><Spinner size="xs" /></span>
      <span v-else class="adot" aria-hidden="true" />
      <span class="akind" role="status">{{ view.title }}</span>
    </div>
    <div v-if="view.body || view.command || view.files.length > 0 || (outputOpen && view.output)" class="ab">
      <p v-if="view.body" class="wcc-text">{{ view.body }}</p>
      <WorktreeCommand v-if="view.command" class="wcc-command" :text="view.command" />
      <ul v-if="view.files.length > 0" class="wcc-files">
        <li v-for="file in view.files" :key="file" class="wcc-file">{{ file }}</li>
      </ul>
      <WorktreeOutput v-if="outputOpen && view.output" class="wcc-output" :text="view.output" />
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
          :disabled="item.id !== 'viewOutput' && busyAction !== null && busyAction !== undefined"
          :aria-expanded="item.id === 'viewOutput' ? outputOpen : undefined"
          :data-action="item.id"
          @click="run(item.id)"
        >
          {{ labelOf(item.id, item.label) }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped src="../lib/dock-card.css"></style>
<style scoped>
.wcc {
  margin: var(--space-2) var(--dock-inline-right, var(--space-4)) var(--space-2) var(--dock-inline-left, var(--space-4));
  font-family: var(--font-ui);
}
.wcc-spin::before {
  content: none;
}
.wcc-text {
  margin: 0;
  color: var(--color-text);
  font: var(--text-base) / var(--leading-normal) var(--font-ui);
  overflow-wrap: anywhere;
}
.ab .wcc-command,
.ab .wcc-output {
  margin-top: var(--space-2);
}
.ab > :first-child {
  margin-top: 0;
}
.wcc-files {
  max-height: calc(var(--space-8) * 5);
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
