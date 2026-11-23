<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { useAnchoredMenu } from '@moonshot-ai/app-components';
import { Button, Icon, IconButton, Input, Menu, MenuItem, Spinner, StatusDot } from '@moonshot-ai/app-ui';

import { track } from '../../lib/track';

const props = defineProps<{
  devices: RcDevice[] | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  currentDeviceId?: string;
  refresh: () => Promise<void>;
  rename: (deviceId: string, alias: string) => Promise<void>;
}>();

const emit = defineEmits<{
  confirm: [device: RcDevice];
}>();

const { t } = useI18n();

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuDevice = ref<RcDevice | null>(null);
const {
  open: menuOpen,
  menuStyle,
  showAnchored,
  close: closeAnchoredMenu,
} = useAnchoredMenu(menuRef);

watch(menuOpen, (open) => {
  if (!open) menuDevice.value = null;
});

async function toggleMenu(device: RcDevice, event: MouseEvent): Promise<void> {
  if (menuOpen.value && menuDevice.value?.device_id === device.device_id) {
    closeAnchoredMenu();
    return;
  }
  menuDevice.value = device;
  await showAnchored(event, 'right');
}

function closeMenu(): void {
  closeAnchoredMenu();
  menuDevice.value = null;
}

function onRefresh(): void {
  track('remote_control_action', { action: 'refresh_devices' });
  void props.refresh();
}

const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameSubmitting = ref(false);
const renameFailed = ref(false);
const renameInput = ref<InstanceType<typeof Input> | null>(null);

async function startRename(device: RcDevice): Promise<void> {
  closeMenu();
  renamingId.value = device.device_id;
  renameValue.value = device.alias;
  renameFailed.value = false;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

function resetRename(): void {
  renamingId.value = null;
  renameValue.value = '';
  renameFailed.value = false;
}

function cancelRename(): void {
  track('remote_control_action', { action: 'rename', outcome: 'cancelled' });
  resetRename();
}

async function submitRename(device: RcDevice): Promise<void> {
  const alias = renameValue.value.trim();
  if (renameSubmitting.value) return;
  if (alias.length === 0 || alias.length > 50) {
    renameFailed.value = true;
    return;
  }
  renameSubmitting.value = true;
  renameFailed.value = false;
  try {
    await props.rename(device.device_id, alias);
    track('remote_control_action', { action: 'rename', outcome: 'ok' });
    resetRename();
  } catch {
    track('remote_control_action', { action: 'rename', outcome: 'error' });
    renameFailed.value = true;
  } finally {
    renameSubmitting.value = false;
  }
}

function requestConfirm(device: RcDevice): void {
  closeMenu();
  emit('confirm', device);
}

function deviceMeta(device: RcDevice): string {
  return [device.platform, device.client_version].filter((part) => part.trim().length > 0).join(' · ');
}
</script>

<template>
  <section class="rc-devices">
    <div class="rc-devices__head">
      <div class="rc-devices__title">{{ t('remoteControl.devicesTitle') }}</div>
      <IconButton
        size="sm"
        :label="t('remoteControl.refreshDevices')"
        :tooltip="t('remoteControl.refresh')"
        :disabled="refreshing"
        @click="onRefresh"
      >
        <Spinner v-if="refreshing" size="xs" />
        <Icon v-else name="refresh" />
      </IconButton>
    </div>

    <div v-if="devices === null && loading" class="rc-devices__center">
      <Spinner size="md" />
    </div>

    <div v-else-if="devices === null && error" class="rc-devices__center">
      <span class="rc-devices__error-title">{{ t('remoteControl.devicesLoadFailed') }}</span>
      <span class="rc-devices__error-detail">{{ error }}</span>
      <Button variant="secondary" size="sm" @click="onRefresh">
        {{ t('remoteControl.retry') }}
      </Button>
    </div>

    <div v-else-if="devices !== null && devices.length === 0" class="rc-devices__empty">
      <Icon name="device-desktop" size="lg" />
      <strong>{{ t('remoteControl.emptyDevicesTitle') }}</strong>
      <span>{{ t('remoteControl.emptyDevicesHint') }}</span>
    </div>

    <template v-else-if="devices !== null">
      <div v-if="error" class="rc-devices__inline-error">
        <span>{{ t('remoteControl.devicesLoadFailed') }}</span>
        <Button variant="text" @click="onRefresh">{{ t('remoteControl.retry') }}</Button>
      </div>
      <div class="rc-devices__list">
        <div
          v-for="device in devices"
          :key="device.device_id"
          class="rc-device"
          :class="{ 'rc-device--offline': device.status !== 'online' }"
        >
          <div class="rc-device__icon">
            <Icon name="device-desktop" />
          </div>

          <form
            v-if="renamingId === device.device_id"
            class="rc-device__rename"
            @submit.prevent="void submitRename(device)"
          >
            <Input
              :ref="
                (el) => {
                  renameInput = el as InstanceType<typeof Input> | null;
                }
              "
              v-model="renameValue"
              size="sm"
              maxlength="50"
              :error="renameFailed"
              :disabled="renameSubmitting"
              :placeholder="t('remoteControl.renamePlaceholder')"
              :aria-label="t('remoteControl.rename')"
              @keydown.esc.prevent="cancelRename"
            />
            <IconButton
              size="sm"
              type="submit"
              :label="t('remoteControl.save')"
              :tooltip="t('remoteControl.save')"
              :disabled="renameSubmitting || renameValue.trim().length === 0"
            >
              <Icon name="check" />
            </IconButton>
            <IconButton
              size="sm"
              :label="t('remoteControl.cancel')"
              :tooltip="t('remoteControl.cancel')"
              :disabled="renameSubmitting"
              @click="cancelRename"
            >
              <Icon name="close" />
            </IconButton>
          </form>

          <template v-else>
            <div class="rc-device__info">
              <div class="rc-device__name-line">
                <span class="rc-device__name" :title="device.alias">{{ device.alias }}</span>
                <span v-if="device.device_id === currentDeviceId" class="rc-device__current">
                  {{ t('remoteControl.currentDevice') }}
                </span>
              </div>
              <div class="rc-device__meta" :title="deviceMeta(device)">{{ deviceMeta(device) }}</div>
            </div>
            <div class="rc-device__status">
              <StatusDot :status="device.status === 'online' ? 'ok' : undefined" />
              <span>{{ device.status === 'online' ? t('remoteControl.online') : t('remoteControl.offline') }}</span>
            </div>
            <IconButton
              class="rc-device__menu-button"
              size="sm"
              :label="t('remoteControl.deviceMenu')"
              :tooltip="t('remoteControl.deviceMenu')"
              @click="void toggleMenu(device, $event)"
            >
              <Icon name="dots-horizontal" size="sm" />
            </IconButton>
          </template>
        </div>
      </div>
      <p v-if="renameFailed" class="rc-device__rename-error">{{ t('remoteControl.renameFailed') }}</p>
    </template>
  </section>

  <Teleport to="body">
    <Transition name="rc-device-menu-pop">
      <Menu
        v-if="menuDevice"
        ref="menuRef"
        class="rc-device__menu"
        role="menu"
        :style="menuStyle"
        @click.stop
      >
        <MenuItem role="menuitem" @click="void startRename(menuDevice)">
          <Icon name="pencil" size="sm" />
          <span>{{ t('remoteControl.rename') }}</span>
        </MenuItem>
        <MenuItem
          v-if="menuDevice.status === 'online'"
          role="menuitem"
          danger
          @click="requestConfirm(menuDevice)"
        >
          <Icon name="close" size="sm" />
          <span>{{ t('remoteControl.deactivate') }}</span>
        </MenuItem>
        <MenuItem
          v-if="menuDevice.status === 'offline'"
          role="menuitem"
          danger
          @click="requestConfirm(menuDevice)"
        >
          <Icon name="trash" size="sm" />
          <span>{{ t('remoteControl.delete') }}</span>
        </MenuItem>
      </Menu>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rc-devices {
  min-width: 0;
}
.rc-devices__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.rc-devices__title {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.rc-devices__center,
.rc-devices__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 132px;
  padding: var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--color-surface);
  text-align: center;
}
.rc-devices__error-title {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.rc-devices__error-detail {
  max-width: 100%;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-devices__empty {
  color: var(--color-text-faint);
}
.rc-devices__empty strong {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.rc-devices__empty span {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.rc-devices__inline-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
  color: var(--color-danger);
  font-size: var(--text-xs);
}
.rc-devices__list {
  margin-top: var(--space-2);
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.rc-device {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 56px;
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.rc-device:last-child {
  border-bottom: 0;
}
.rc-device__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text-muted);
}
.rc-device__info {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.rc-device__name-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.rc-device__name {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-device__current {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--color-selected);
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: var(--weight-medium);
}
.rc-device__meta {
  margin-top: 2px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-device__status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.rc-device--offline .rc-device__name,
.rc-device--offline .rc-device__status {
  color: var(--color-text-faint);
}
.rc-device__rename {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.rc-device__rename-error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--text-xs);
}
.rc-device__menu {
  position: fixed;
  z-index: calc(var(--z-modal) + 1);
  min-width: 148px;
  overflow-y: auto;
  user-select: none;
}
.rc-device-menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.rc-device-menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.rc-device-menu-pop-enter-from,
.rc-device-menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}

@media (max-width: 720px) {
  .rc-device__status span:last-child {
    display: none;
  }
  .rc-device__meta {
    max-width: 220px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rc-device-menu-pop-enter-active,
  .rc-device-menu-pop-leave-active {
    transition: none;
  }
}
</style>
