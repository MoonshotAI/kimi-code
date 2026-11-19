<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Button,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  Switch,
  menuNavigationIndex,
} from '@moonshot-ai/app-ui';
import {
  pluginRowShowsInstall,
  usePlugins,
  useMcpAuthorization,
  type PluginRowAction,
  type PluginViewModel,
} from '@moonshot-ai/app-client/composables';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';
import ConfirmDialog from '../dialogs/ConfirmDialog.vue';

const props = defineProps<{
  row: PluginViewModel;
  installVariant?: 'primary' | 'secondary';
}>();
const { t } = useI18n();
const { state, installRow, remove, setEnabled, busyKey } = usePlugins();
const { authorizePlugin } = useMcpAuthorization();

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, toggleAnchored, close } = useAnchoredMenu(menuRef);
let returnFocus: HTMLElement | undefined;

const installBusy = computed(() => isBusy(props.row.installId, 'install'));
const removeBusy = computed(() =>
  props.row.installedPlugin === undefined ? false : isBusy(props.row.installedPlugin.id, 'remove'),
);
const toggleBusy = computed(() =>
  props.row.installedPlugin === undefined ? false : isBusy(props.row.installedPlugin.id, 'toggle'),
);
const running = computed(() => props.row.capability?.install.running === true);
const rowBusy = computed(() =>
  installBusy.value || removeBusy.value || toggleBusy.value || running.value,
);
const showInstall = computed(() => pluginRowShowsInstall(props.row));
const installDisabled = computed(() =>
  rowBusy.value ||
  props.row.capabilityUnavailable ||
  props.row.cloudOnly ||
  props.row.capability?.supported === false,
);
const installLabel = computed(() => {
  if (running.value || installBusy.value) return t('settings.plugins.installing');
  if (props.row.updateAvailable) return t('settings.plugins.update');
  return t('settings.plugins.install');
});

function isBusy(id: string, action: PluginRowAction): boolean {
  return state.busy[busyKey(id, action)] === true;
}

async function install(): Promise<void> {
  const firstInstall = props.row.installedPlugin === undefined;
  await installRow(props.row, { confirmStopProcesses });
  if (!firstInstall) return;
  const entry = props.row.catalogEntry;
  if (entry === undefined || entry.capabilityId !== undefined) return;
  if (state.rowErrors[entry.id] !== undefined) return;
  const installed = state.installed.find((plugin) => plugin.catalogId === entry.id) ??
    state.installed.find((plugin) => plugin.id === entry.id);
  if (installed === undefined) return;
  await authorizePlugin(installed.id);
}

const stopProcessesConfirmOpen = ref(false);
const stopProcessesConfirmCopy = computed(() => {
  const webbridge = props.row.updateAvailable && props.row.capability?.id === 'kimi-webbridge';
  return {
    title: t(webbridge
      ? 'settings.plugins.webbridgeStopProcessesConfirmTitle'
      : 'settings.plugins.stopProcessesConfirmTitle'),
    message: t(webbridge
      ? 'settings.plugins.webbridgeStopProcessesConfirmMessage'
      : 'settings.plugins.stopProcessesConfirmMessage', { name: props.row.displayName }),
    action: t(webbridge
      ? 'settings.plugins.webbridgeStopProcessesConfirmAction'
      : 'settings.plugins.stopProcessesConfirmAction'),
  };
});
let resolveStopProcesses: ((confirmed: boolean) => void) | undefined;

function confirmStopProcesses(): Promise<boolean> {
  stopProcessesConfirmOpen.value = true;
  return new Promise((resolve) => { resolveStopProcesses = resolve; });
}

function finishStopProcessesConfirmation(confirmed: boolean): void {
  stopProcessesConfirmOpen.value = false;
  resolveStopProcesses?.(confirmed);
  resolveStopProcesses = undefined;
}

onBeforeUnmount(() => finishStopProcessesConfirmation(false));

function enabledItems(): HTMLElement[] {
  return [
    ...(menuRef.value?.el?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? []),
  ];
}

async function toggleMenu(event: MouseEvent): Promise<void> {
  returnFocus = event.currentTarget as HTMLElement;
  await toggleAnchored(event, 'right');
  if (open.value) enabledItems()[0]?.focus();
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    returnFocus?.focus();
    return;
  }
  const items = enabledItems();
  const next = menuNavigationIndex(
    event.key,
    event.shiftKey,
    items.indexOf(document.activeElement as HTMLElement),
    items.length,
  );
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

const removeConfirmOpen = ref(false);

function requestRemove(): void {
  if (props.row.installedPlugin === undefined) return;
  close();
  if (returnFocus?.isConnected) returnFocus.focus();
  removeConfirmOpen.value = true;
}

function cancelRemove(): void {
  removeConfirmOpen.value = false;
  void nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
  });
}

async function removePlugin(): Promise<void> {
  const id = props.row.installedPlugin?.id;
  if (id === undefined || removeBusy.value) return;
  try {
    await remove(id);
  } finally {
    removeConfirmOpen.value = false;
    void nextTick(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }
}
</script>

<template>
  <div class="plugin-actions" @click.stop>
    <Button
      v-if="showInstall"
      size="xs"
      :variant="installVariant ?? (row.installedPlugin ? 'secondary' : 'primary')"
      :loading="installBusy || running"
      :disabled="installDisabled"
      @click="install"
    >
      {{ installLabel }}
    </Button>
    <template v-if="row.installedPlugin">
      <Switch
        :model-value="row.installedPlugin.enabled"
        :disabled="rowBusy"
        :aria-label="t('settings.plugins.enabled')"
        @update:model-value="setEnabled(row.installedPlugin!.id, $event)"
      />
      <IconButton
        size="sm"
        :label="t('settings.plugins.moreActions')"
        :tooltip="t('settings.plugins.moreActions')"
        :aria-expanded="open"
        aria-haspopup="menu"
        :disabled="rowBusy"
        @click="toggleMenu"
      >
        <Icon name="dots-horizontal" size="md" />
      </IconButton>
      <Transition name="menu-pop">
        <Menu
          v-if="open"
          ref="menuRef"
          class="plugin-actions__menu"
          :style="menuStyle"
          @click.stop
          @keydown="onMenuKeydown"
        >
          <MenuItem danger :disabled="rowBusy" @click="requestRemove">
            <Icon name="trash" size="sm" />
            {{ t('settings.plugins.remove') }}
          </MenuItem>
        </Menu>
      </Transition>
    </template>
    <ConfirmDialog
      :open="stopProcessesConfirmOpen"
      :title="stopProcessesConfirmCopy.title"
      :message="stopProcessesConfirmCopy.message"
      :confirm-label="stopProcessesConfirmCopy.action"
      variant="danger"
      initial-focus="cancel"
      @update:open="!$event && finishStopProcessesConfirmation(false)"
      @confirm="finishStopProcessesConfirmation(true)"
      @cancel="finishStopProcessesConfirmation(false)"
    />
    <ConfirmDialog
      :open="removeConfirmOpen"
      :title="t('settings.plugins.removeConfirmTitle')"
      :message="t('settings.plugins.removeConfirmMessage', { name: row.displayName })"
      :confirm-label="t('settings.plugins.remove')"
      :loading="removeBusy"
      variant="danger"
      initial-focus="cancel"
      @update:open="removeConfirmOpen = $event"
      @confirm="removePlugin"
      @cancel="cancelRemove"
    />
  </div>
</template>

<style scoped>
.plugin-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-4);
}

.plugin-actions__menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}

.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
