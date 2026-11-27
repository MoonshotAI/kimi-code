<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NewSessionEnvironment } from '@moonshot-ai/app-core/lib';
import { toastWithManage, useNewSessionEnvironment } from '@moonshot-ai/app-client/composables';
import { formatWorktreeSize } from '@moonshot-ai/app-client/lib';
import { worktreesStore } from '@moonshot-ai/app-client/stores';
import { Icon, MenuItem, Spinner, menuNavigationIndex } from '@moonshot-ai/app-ui';
import CreatePicker from './CreatePicker.vue';

const props = defineProps<{
  workspaceId?: string | null;
}>();

interface EnvironmentOption {
  id: NewSessionEnvironment;
  icon: string;
  label: string;
  description: string;
  disabled: boolean;
  loading: boolean;
}

const { t } = useI18n();
const store = useNewSessionEnvironment();

const view = computed(() => store.view(props.workspaceId));

const options = computed<EnvironmentOption[]>(() => {
  const availability = view.value.availability;
  const explanation =
    availability === 'notGitRepo'
      ? t('worktreeCreate.environment.notGitRepo')
      : availability === 'remoteHost'
        ? t('worktreeCreate.environment.remoteHost')
        : availability === 'failed'
          ? t('worktreeCreate.environment.failed')
          : t('worktreeCreate.environment.worktreeDescription');
  return [
    {
      id: 'local',
      icon: 'device-desktop',
      label: t('worktreeCreate.environment.local'),
      description: t('worktreeCreate.environment.localDescription'),
      disabled: false,
      loading: false,
    },
    {
      id: 'worktree',
      icon: 'git-fork',
      label: t('worktreeCreate.environment.worktree'),
      description: explanation,
      disabled: availability !== 'available',
      loading: availability === 'loading',
    },
  ];
});

const current = computed(() => options.value.find((option) => option.id === view.value.effective) ?? options.value[0]!);

const picker = ref<InstanceType<typeof CreatePicker> | null>(null);
const open = ref(false);
const activeIndex = ref(0);
const rowId = `${useId()}-option`;

watch(open, async (isOpen) => {
  if (!isOpen) return;
  void store.refreshBranches(props.workspaceId);
  activeIndex.value = Math.max(0, options.value.findIndex((option) => option.id === view.value.effective));
  await nextTick();
  picker.value?.focusPanel();
});

let stopAwaitingDiskUsage: (() => void) | null = null;

function awaitDiskUsage(): void {
  if (stopAwaitingDiskUsage !== null || worktreesStore().totalSizeBytes !== undefined) return;
  stopAwaitingDiskUsage = watch(
    () => worktreesStore().totalSizeBytes,
    (total) => {
      if (total === undefined) return;
      stopAwaitingDiskUsage?.();
      stopAwaitingDiskUsage = null;
      if (store.preferred === 'worktree') void remindDiskUsage();
    },
  );
}

onBeforeUnmount(() => stopAwaitingDiskUsage?.());

async function remindDiskUsage(): Promise<void> {
  let bytes: number | null = null;
  try {
    bytes = await worktreesStore().checkDiskUsageReminder();
  } catch {
    return;
  }
  if (bytes === null) {
    awaitDiskUsage();
    return;
  }
  stopAwaitingDiskUsage?.();
  stopAwaitingDiskUsage = null;
  worktreesStore().markDiskUsageReminded();
  toastWithManage(t('worktreeCreate.disk.reminder', { size: formatWorktreeSize(bytes) }), { replace: false });
}

function select(option: EnvironmentOption): void {
  if (option.disabled) return;
  store.selectEnvironment(option.id);
  picker.value?.close({ focusTrigger: true });
  if (option.id === 'worktree') void remindDiskUsage();
}

function hover(option: EnvironmentOption, index: number): void {
  if (!option.disabled) activeIndex.value = index;
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = options.value[activeIndex.value];
    if (option !== undefined) select(option);
    return;
  }
  const enabled = options.value.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
  const position = enabled.findIndex(({ index }) => index === activeIndex.value);
  const next = menuNavigationIndex(event.key, event.shiftKey, position, enabled.length);
  if (next === null) return;
  event.preventDefault();
  if (next >= 0) activeIndex.value = enabled[next]!.index;
}
</script>

<template>
  <CreatePicker
    ref="picker"
    v-model:open="open"
    class="wce"
    data-worktree-environment
    popup="menu"
    chip-class="wce-chip"
    panel-class="wce-panel"
    :label="`${t('worktreeCreate.environment.label')}: ${current.label}`"
    :panel-label="t('worktreeCreate.environment.label')"
    :data-environment="current.id"
    :active-descendant="open ? `${rowId}-${activeIndex}` : undefined"
    @panel-keydown="onPanelKeydown"
  >
    <template #chip>
      <Icon class="wce-chip-icon" :name="current.icon" size="md" />
      <span class="wce-chip-name">{{ current.label }}</span>
    </template>
    <MenuItem
      v-for="(option, index) in options"
      :key="option.id"
      :id="`${rowId}-${index}`"
      class="wce-row"
      role="menuitemradio"
      tabindex="-1"
      :selected="option.id === current.id"
      :active="index === activeIndex"
      :disabled="option.disabled"
      :data-option="option.id"
      @mousemove="hover(option, index)"
      @click.stop="select(option)"
    >
      <template #icon><Icon :name="option.icon" size="md" /></template>
      <span class="wce-row-text">
        <span class="wce-row-label">{{ option.label }}</span>
        <span class="wce-row-desc">{{ option.description }}</span>
      </span>
      <Spinner v-if="option.loading" class="wce-row-spinner" size="sm" :label="t('worktreeCreate.environment.checking')" />
    </MenuItem>
  </CreatePicker>
</template>

<style scoped>
.wce {
  flex: none;
}
.wce-chip-icon {
  flex: none;
}
.wce-chip-name {
  font-weight: var(--weight-option-label);
}
.wce :deep(.wce-panel) {
  gap: var(--space-05);
  width: max-content;
  min-width: calc(var(--space-8) * 8);
  max-width: min(calc(var(--space-8) * 13), calc(100vw - var(--space-8)));
}
.wce-row.ui-menu-item {
  align-items: flex-start;
}
.wce-row > :deep(svg) {
  margin-top: calc((var(--text-base) * var(--leading-normal) - var(--p-ic-md)) / 2);
}
.wce-row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.wce-row-label {
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.wce-row-desc {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.wce-row-spinner {
  flex: none;
  margin-top: calc((var(--text-base) * var(--leading-normal) - var(--p-ic-sm)) / 2);
  margin-left: var(--space-3);
}
</style>
