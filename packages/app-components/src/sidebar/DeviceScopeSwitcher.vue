<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import { devicesStore, sessionViewsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

type ScopeTone = 'waiting' | 'running' | 'unavailable' | 'none';

interface ScopeOption {
  readonly key: string;
  readonly deviceId: string | undefined;
  readonly label: string;
  readonly hint: string;
  readonly tone: ScopeTone;
}

const LOCAL_KEY = 'local';

const { t } = useI18n();
const devices = devicesStore();
const sessionViews = sessionViewsStore();
const workspaces = workspacesStore();
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, showAnchored, close } = useAnchoredMenu(menuRef);

const remoteDevices = computed(() => devices.devices.filter((device) => device.enabled !== false && (device.connection === 'ssh' || device.connection === 'account')));

const activity = computed(() => {
  const out = new Map<string, { waiting: number; running: number }>();
  for (const session of sessionViews.sessionsForView) {
    const key = session.deviceId ?? LOCAL_KEY;
    const entry = out.get(key) ?? { waiting: 0, running: 0 };
    const pending = sessionViews.pendingBySession[session.id];
    const status = sessionDisplayStatus({
      busy: session.busy ?? false,
      unread: false,
      approvalCount: pending?.approvals ?? 0,
      questionCount: pending?.questions ?? 0,
      pendingInteraction: session.pendingInteraction,
      lastTurnReason: session.lastTurnReason,
    });
    if (status === 'awaiting-approval' || status === 'awaiting-question') entry.waiting += 1;
    else if (status === 'running') entry.running += 1;
    out.set(key, entry);
  }
  return out;
});

function describe(deviceId: string | undefined): { hint: string; tone: ScopeTone } {
  if (deviceId !== undefined && devices.unavailable(deviceId)) return { hint: t('sidebar.deviceUnavailable'), tone: 'unavailable' };
  const entry = activity.value.get(deviceId ?? LOCAL_KEY);
  if (entry !== undefined && entry.waiting > 0) return { hint: t('sidebar.deviceWaiting', { n: entry.waiting }), tone: 'waiting' };
  if (entry !== undefined && entry.running > 0) return { hint: t('sidebar.deviceRunning', { n: entry.running }), tone: 'running' };
  return { hint: '', tone: 'none' };
}

const options = computed<ScopeOption[]>(() => [
  { key: LOCAL_KEY, deviceId: undefined, label: t('sidebar.thisComputer'), ...describe(undefined) },
  ...remoteDevices.value.map((device) => ({
    key: device.id,
    deviceId: device.id,
    label: devices.displayName(device.id) ?? device.id,
    ...describe(device.id),
  })),
]);

const current = computed(() => options.value.find((option) => option.deviceId === workspaces.deviceScope) ?? options.value[0]!);
const attentionElsewhere = computed(() => options.value.some((option) => option.deviceId !== workspaces.deviceScope && option.tone === 'waiting'));
const buttonLabel = computed(() => {
  const label = `${t('sidebar.deviceScope')}: ${current.value.label}`;
  return attentionElsewhere.value ? `${label}, ${t('sidebar.deviceScopeAttention')}` : label;
});

async function toggle(event: MouseEvent): Promise<void> {
  if (open.value) {
    close();
    return;
  }
  await showAnchored(event, 'left');
}

function select(option: ScopeOption): void {
  close();
  workspaces.setDeviceScope(option.deviceId);
}
</script>

<template>
  <template v-if="remoteDevices.length > 0">
    <span class="dss-sep" aria-hidden="true">·</span>
    <button
      type="button"
      class="dss"
      :class="{ open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="buttonLabel"
      @click.stop="toggle"
    >
      <span class="dss-name">{{ current.label }}</span>
      <Icon name="chevron-down" size="sm" />
      <span v-if="attentionElsewhere" class="dss-dot" aria-hidden="true" />
    </button>
    <Transition name="ui-menu-pop">
      <Menu v-if="open" ref="menuRef" class="ui-menu-floating dss-menu" :style="menuStyle" @click.stop>
        <MenuItem
          v-for="option in options"
          :key="option.key"
          class="dss-item"
          :active="option.deviceId === workspaces.deviceScope"
          @click="select(option)"
        >
          <Icon :name="option.deviceId === undefined ? 'device-desktop' : 'server'" size="sm" />
          <span class="dss-label">{{ option.label }}</span>
          <span v-if="option.hint" class="dss-hint" :class="`dss-hint--${option.tone}`">{{ option.hint }}</span>
        </MenuItem>
        <MenuItem separator />
        <div class="dss-foot">{{ t('sidebar.deviceScopePinHint') }}</div>
      </Menu>
    </Transition>
  </template>
</template>

<style scoped>
.dss-sep { flex: none; color: var(--color-text-faint); }
.dss { position: relative; display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 160px; margin-left: -2px; padding: 1px var(--space-1); border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); font: inherit; text-transform: none; cursor: pointer; }
.dss:hover, .dss.open { background: var(--color-hover); color: var(--color-text); }
.dss:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.dss-name { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; }
.dss-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning); }
.dss-menu { min-width: 220px; font-weight: normal; text-transform: none; }
.dss-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dss-hint { flex: none; color: var(--color-text-faint); font-size: var(--text-xs); }
.dss-hint--waiting { color: var(--color-warning); }
.dss-hint--running { color: var(--color-success); }
.dss-hint--unavailable { color: var(--color-danger); }
.dss-foot { padding: var(--space-1) var(--space-2) var(--space-1-5); color: var(--color-text-faint); font-family: var(--font-ui); font-size: var(--text-xs); }
</style>
