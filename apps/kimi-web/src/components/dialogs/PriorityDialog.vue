<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

export type PriorityMode = 'off' | 'main' | 'subagents' | 'both';

const props = defineProps<{
  open: boolean;
  mainPriority: boolean;
  subagentPriority: boolean;
  saving?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  apply: [value: { main: boolean; subagents: boolean }];
}>();

const { t } = useI18n();

function modeFor(main: boolean, subagents: boolean): PriorityMode {
  if (main && subagents) return 'both';
  if (main) return 'main';
  if (subagents) return 'subagents';
  return 'off';
}

const mode = ref<PriorityMode>(modeFor(props.mainPriority, props.subagentPriority));

watch(
  () => props.open,
  (open) => {
    if (open) mode.value = modeFor(props.mainPriority, props.subagentPriority);
  },
);

const options = computed(() => [
  { value: 'off', label: t('commands.priority.off') },
  { value: 'main', label: t('commands.priority.main') },
  { value: 'subagents', label: t('commands.priority.subagents') },
  { value: 'both', label: t('commands.priority.both') },
]);

const description = computed(() => t(`commands.priority.${mode.value}Desc`));

function apply(): void {
  emit('apply', {
    main: mode.value === 'main' || mode.value === 'both',
    subagents: mode.value === 'subagents' || mode.value === 'both',
  });
}

function setMode(value: string): void {
  if (value === 'off' || value === 'main' || value === 'subagents' || value === 'both') {
    mode.value = value;
  }
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('commands.priority.title')"
    :description="t('commands.priority.dialogDesc')"
    @update:open="emit('update:open', $event)"
  >
    <div class="priority-options">
      <SegmentedControl
        :model-value="mode"
        :options="options"
        @update:model-value="setMode"
      />
      <p class="priority-description">{{ description }}</p>
    </div>
    <template #foot>
      <Button variant="secondary" :disabled="saving" @click="emit('update:open', false)">
        {{ t('common.cancel') }}
      </Button>
      <Button :loading="saving" @click="apply">{{ t('commands.priority.apply') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.priority-options {
  display: grid;
  gap: var(--space-3);
}
.priority-options :deep(.ui-seg) {
  width: 100%;
}
.priority-options :deep(.ui-seg__item) {
  flex: 1;
}
.priority-description {
  min-height: 3em;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
