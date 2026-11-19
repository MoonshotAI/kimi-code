// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import RcDeviceSwitcher from '../src/sidebar/RcDeviceSwitcher.vue';

const DEVICES = [
  {
    device_id: 'dev-1',
    alias: 'Workstation',
    status: 'online',
    platform: 'darwin',
    client_version: 'kimi-code-desktop/1.0.4',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_remote_access_at: '2026-01-01T00:00:00.000Z',
  },
  {
    device_id: 'dev-2',
    alias: 'Laptop',
    status: 'online',
    platform: 'linux',
    client_version: 'kimi-code/2.1.1',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_remote_access_at: '2026-01-01T00:00:00.000Z',
  },
  {
    device_id: 'dev-3',
    alias: 'Old box',
    status: 'offline',
    platform: 'win32',
    client_version: 'kimi-code/2.0.0',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_remote_access_at: '2026-01-01T00:00:00.000Z',
  },
];

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ devices: DEVICES, max_devices: 3 }), { status: 200 }),
      ),
    ),
  );
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  document.body.querySelectorAll('.rc-dev-menu').forEach((el) => el.remove());
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

function mount(): HTMLElement {
  app = createApp({ render: () => h(RcDeviceSwitcher) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({
    render: () => h('svg', { 'data-icon': name }),
  }));
  app.mount(host);
  return host;
}

describe('RcDeviceSwitcher', () => {
  it('stays hidden outside rc mode and never fetches', async () => {
    window.history.replaceState(null, '', '/');
    const root = mount();
    await Promise.resolve();
    expect(root.querySelector('.rc-dev-trigger')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists online and offline devices with the current one marked', async () => {
    window.history.replaceState(null, '', '/devices/dev-1/?rc=1&from=kimi_code_desktop');
    const root = mount();
    await vi.waitFor(() => {
      expect(root.querySelector('.rc-dev-trigger')?.textContent).toContain('Workstation');
    });

    root.querySelector<HTMLButtonElement>('.rc-dev-trigger')!.click();
    await vi.waitFor(() => {
      expect(document.body.querySelector('.rc-dev-menu')).not.toBeNull();
    });
    const menu = document.body.querySelector('.rc-dev-menu') as HTMLElement;
    expect(menu.textContent).toContain('Connectable');
    expect(menu.textContent).toContain('Workstation');
    expect(menu.textContent).toContain('Laptop');
    expect(menu.textContent).toContain('Unavailable');
    expect(menu.textContent).toContain('Old box');
    const current = menu.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain('Workstation');
  });

  it('shows the failure state when the device list cannot load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network down'))),
    );
    window.history.replaceState(null, '', '/devices/dev-1/?rc=1');
    const root = mount();

    root.querySelector<HTMLButtonElement>('.rc-dev-trigger')!.click();
    await vi.waitFor(() => {
      expect(document.body.querySelector('.rc-dev-menu')?.textContent).toContain(
        'Failed to load devices',
      );
    });
  });
});
