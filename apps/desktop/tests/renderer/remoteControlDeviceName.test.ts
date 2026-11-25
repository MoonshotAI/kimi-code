// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { RemoteControlStatus } from '@moonshot-ai/app-core/api';
import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { configStore, devicesStore, setDevicesHooks } from '@moonshot-ai/app-client/stores';

import RemoteControlDeviceName from '../../src/renderer/components/remote-control/RemoteControlDeviceName.vue';

let app: App | undefined;
let host: HTMLDivElement;
const track = vi.fn();

function registration(id: string, alias: string): RcDevice {
  return {
    device_id: id,
    alias,
    status: 'online',
    platform: 'darwin',
    client_version: 'kimi-code-desktop/1.3.7',
    local_base_url: '',
    created_at: '',
    updated_at: '',
    last_remote_access_at: '',
  };
}

async function mount(status: RemoteControlStatus | null = null): Promise<void> {
  app = createApp({ render: () => h(RemoteControlDeviceName, { status }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  for (let index = 0; index < 4; index++) await nextTick();
}

function renameButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('.rcp-device__rename-button');
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  track.mockReset();
  (globalThis as { kimiDesktop?: unknown }).kimiDesktop = { getHostName: async () => 'studio-mac.local', track };
  configStore().deviceId = 'this-mac';
  setDevicesHooks({ localDeviceId: () => configStore().deviceId });
  devicesStore().registrations = null;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
  delete (globalThis as { kimiDesktop?: unknown }).kimiDesktop;
  configStore().deviceId = '';
  setDevicesHooks(null);
  devicesStore().registrations = null;
});

describe('RemoteControlDeviceName', () => {
  it('names this computer by its Remote Control alias and renames it through its own device id', async () => {
    devicesStore().registrations = [registration('rc-other', 'Gaming PC'), registration('this-mac', 'Studio')];
    const rename = vi.spyOn(devicesStore(), 'renameRegistration').mockResolvedValue();
    await mount();

    expect(host.querySelector('.rcp-device__name')?.textContent).toBe('Studio');
    renameButton()!.click();
    await nextTick();
    const input = host.querySelector<HTMLInputElement>('.rcp-device__rename input')!;
    expect(input.value).toBe('Studio');
    input.value = '  Desk Mac  ';
    input.dispatchEvent(new Event('input'));
    host.querySelector<HTMLFormElement>('.rcp-device__rename')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(rename).toHaveBeenCalledExactlyOnceWith('this-mac', 'Desk Mac'));
    await nextTick();

    expect(host.querySelector('.rcp-device__rename')).toBeNull();
    expect(track).toHaveBeenCalledWith('remote_control_action', { action: 'rename', outcome: 'ok' });
  });

  it('shows the name the app would register before this computer is registered, without a rename action', async () => {
    devicesStore().registrations = [registration('rc-other', 'Gaming PC')];
    await mount({ enabled: false, state: 'off' });

    expect(host.querySelector('.rcp-device__name')?.textContent).toBe('studio-mac.local');
    expect(renameButton()).toBeNull();
  });

  it('can rename while Remote Control runs even before the device list has loaded', async () => {
    await mount({ enabled: true, state: 'on', device_id: 'this-mac', device_name: 'studio-mac' });

    expect(host.querySelector('.rcp-device__name')?.textContent).toBe('studio-mac');
    expect(renameButton()).not.toBeNull();
  });

  it('keeps the name editable and reports the failure when renaming fails', async () => {
    devicesStore().registrations = [registration('this-mac', 'Studio')];
    vi.spyOn(devicesStore(), 'renameRegistration').mockRejectedValue(new Error('cloud unavailable'));
    await mount();

    renameButton()!.click();
    await nextTick();
    host.querySelector<HTMLFormElement>('.rcp-device__rename')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(host.querySelector('.rcp-device__error')?.textContent).toBe('Rename failed. Please try again'));

    expect(host.querySelector('.rcp-device__rename')).not.toBeNull();
    expect(track).toHaveBeenCalledWith('remote_control_action', { action: 'rename', outcome: 'error' });
  });

  it('shows nothing until a name is known', async () => {
    delete (globalThis as { kimiDesktop?: unknown }).kimiDesktop;
    await mount();

    expect(host.querySelector('.rcp-device')).toBeNull();
  });
});
