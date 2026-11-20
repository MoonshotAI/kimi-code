<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NewSessionEnvironment } from '@moonshot-ai/app-core/lib';
import { toast } from '@moonshot-ai/app-client/client';
import { openWorktreeSettings } from '@moonshot-ai/app-client/composables';
import { formatWorktreeSize } from '@moonshot-ai/app-client/lib';
import { newSessionEnvironmentStore, worktreesStore } from '@moonshot-ai/app-client/stores';
import { Icon, Spinner, menuNavigationIndex } from '@moonshot-ai/app-ui';
import { useCreatePopover } from './createPopover';

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

const DISK_REMINDER_MS = 8000;

const { t } = useI18n();
const store = newSessionEnvironmentStore();

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

const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const { open, up, toggle, close } = useCreatePopover(anchorRef, panelRef, triggerRef);
const activeIndex = ref(0);

watch(open, async (isOpen) => {
  if (!isOpen) return;
  void store.ensureBranches(props.workspaceId);
  activeIndex.value = Math.max(0, options.value.findIndex((option) => option.id === view.value.effective));
  await nextTick();
  panelRef.value?.focus({ preventScroll: true });
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
  toast({
    layout: 'bar',
    title: t('worktreeCreate.disk.reminder', { size: formatWorktreeSize(bytes) }),
    duration: DISK_REMINDER_MS,
    actions: [
      {
        label: t('worktreeCreate.disk.manage'),
        onClick: ({ dismiss }) => {
          dismiss();
          openWorktreeSettings();
        },
      },
    ],
  });
}

function select(option: EnvironmentOption): void {
  if (option.disabled) return;
  store.selectEnvironment(option.id);
  close({ focusTrigger: true });
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
  <div ref="anchorRef" class="wce" data-worktree-environment>
    <button
      ref="triggerRef"
      type="button"
      class="wce-chip"
      :class="{ open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`${t('worktreeCreate.environment.label')}: ${current.label}`"
      :data-environment="current.id"
      @click.stop="toggle"
    >
      <Icon :name="current.icon" size="md" />
      <span class="wce-chip-name">{{ current.label }}</span>
      <Icon class="wce-chip-chev" name="chevron-down" size="sm" />
    </button>
    <div
      v-if="open"
      ref="panelRef"
      class="wce-panel"
      :class="{ up }"
      role="menu"
      tabindex="-1"
      :aria-label="t('worktreeCreate.environment.label')"
      @keydown="onPanelKeydown"
    >
      <button
        v-for="(option, index) in options"
        :key="option.id"
        type="button"
        class="wce-row"
        :class="{ on: option.id === current.id, active: index === activeIndex, disabled: option.disabled }"
        role="menuitemradio"
        tabindex="-1"
        :aria-checked="option.id === current.id"
        :aria-disabled="option.disabled"
        :data-option="option.id"
        @mousemove="hover(option, index)"
        @click.stop="select(option)"
      >
        <Icon class="wce-row-icon" :name="option.icon" size="md" />
        <span class="wce-row-text">
          <span class="wce-row-label">{{ option.label }}</span>
          <span class="wce-row-desc">{{ option.description }}</span>
        </span>
        <Spinner v-if="option.loading" class="wce-row-end" size="sm" :label="t('worktreeCreate.environment.checking')" />
        <Icon v-else-if="option.id === current.id" class="wce-row-end" name="check" size="sm" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.wce {
  position: relative;
  display: flex;
  flex: none;
  font-family: var(--font-ui);
}
.wce-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: 10px;
  background: var(--color-selected);
  -webkit-backdrop-filter: blur(30px);
  backdrop-filter: blur(30px);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.wce-chip:hover,
.wce-chip.open {
  color: var(--color-text-strong);
}
.wce-chip:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.wce-chip > .kw-icon {
  flex: none;
}
.wce-chip-name {
  font-weight: var(--weight-option-label);
}
.wce-chip-chev {
  transition: transform var(--duration-base) var(--ease-out);
}
.wce-chip.open .wce-chip-chev {
  transform: rotate(180deg);
}
.wce-panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-dropdown);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  min-width: calc(var(--space-8) * 8);
  max-width: min(calc(var(--space-8) * 13), calc(100vw - var(--space-8)));
  padding: var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-sm);
  animation: wce-pop var(--duration-base) var(--ease-out);
}
.wce-panel:focus {
  outline: none;
}
.wce-panel.up {
  top: auto;
  bottom: calc(100% + var(--space-1));
}
@keyframes wce-pop {
  from {
    opacity: 0;
    transform: scale(0.99);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.wce-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-dropdown-row);
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.wce-row.active {
  background: var(--color-hover);
}
.wce-row.on {
  background: var(--color-selected);
}
.wce-row.disabled {
  cursor: default;
}
.wce-row-icon {
  flex: none;
  color: var(--color-text-muted);
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
  font-weight: var(--weight-option-label);
  line-height: var(--leading-normal);
}
.wce-row-desc {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-normal);
}
.wce-row.disabled .wce-row-icon,
.wce-row.disabled .wce-row-label {
  color: var(--color-text-faint);
}
.wce-row-end {
  flex: none;
  margin-left: var(--space-3);
  color: var(--color-text);
}
.wce-row.disabled .wce-row-end {
  color: var(--color-text-faint);
}
</style>
