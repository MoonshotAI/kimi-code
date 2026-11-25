// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref, type App } from 'vue';
import type { AppSystemStats } from '@moonshot-ai/app-core/api';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';

import SessionInfoDevice from '../../src/renderer/components/chat/SessionInfoDevice.vue';

const GIB = 1024 ** 3;

const deviceStats = vi.hoisted(() => ({
  stats: undefined as unknown as { value: AppSystemStats | null },
  stale: undefined as unknown as { value: boolean },
  targets: [] as unknown[],
}));

vi.mock('@moonshot-ai/app-client/composables', () => ({
  useDeviceStats: (source: () => unknown) => {
    deviceStats.targets.push(source());
    return { stats: deviceStats.stats, stale: deviceStats.stale };
  },
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  devicesStore: () => ({ displayName: (id: string) => (id === 'gpu-box' ? 'GPU Box' : undefined) }),
}));

let app: App | undefined;
let host: HTMLDivElement | undefined;

function reading(overrides: Partial<AppSystemStats> = {}): AppSystemStats {
  return {
    cpu: { usage: 0.42, cores: 2.5, limited: true },
    memory: { total: 16 * GIB, used: 8 * GIB, limited: false },
    disk: { path: '/srv/app', total: 100 * GIB, used: 92 * GIB, available: 4 * GIB },
    gpus: [
      { index: 0, name: 'NVIDIA H100', memoryTotal: 80 * GIB, memoryUsed: 76 * GIB, utilization: 0.97 },
      { index: 1, name: 'NVIDIA H100', memoryTotal: 80 * GIB, memoryUsed: 4 * GIB, utilization: 0 },
    ],
    ...overrides,
  };
}

function mount(target: { deviceId: string; path?: string } | undefined): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(SessionInfoDevice, { target });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
  return host;
}

function rows(root: HTMLElement): string[][] {
  return [...root.querySelectorAll('.sid-row')].map((row) => [
    row.querySelector('.sid-label')?.textContent?.trim() ?? '',
    row.querySelector('.sid-value')?.textContent?.trim() ?? '',
    row.classList.contains('is-high') ? 'high' : '',
  ]);
}

beforeEach(() => {
  deviceStats.stats = ref<AppSystemStats | null>(reading());
  deviceStats.stale = ref(false);
  deviceStats.targets = [];
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe('SessionInfoDevice', () => {
  it('shows CPU, memory, disk and GPU memory of the device and marks the nearly full ones', () => {
    const root = mount({ deviceId: 'gpu-box', path: '/srv/app' });

    expect(deviceStats.targets).toEqual([{ deviceId: 'gpu-box', path: '/srv/app' }]);
    expect(root.querySelector('.sid-title')?.textContent).toBe('运行在 GPU Box');
    expect(rows(root)).toEqual([
      ['CPU', '42%', ''],
      ['内存', '50%', ''],
      ['磁盘', '96%', 'high'],
      ['显存', '50%', ''],
    ]);
    const gpuBars = [...root.querySelectorAll('.sid-gpus [role="progressbar"]')];
    expect(gpuBars.map((bar) => [bar.getAttribute('aria-label'), bar.classList.contains('is-high')])).toEqual([
      ['GPU 0 · NVIDIA H100 95%', true],
      ['GPU 1 · NVIDIA H100 5%', false],
    ]);
  });

  it('dims the last reading and says so while it cannot refresh', async () => {
    const root = mount({ deviceId: 'gpu-box' });
    expect(root.querySelector('.sid-stale')).toBeNull();

    deviceStats.stale.value = true;
    await nextTick();

    expect(root.querySelector('.si-device')?.classList.contains('is-stale')).toBe(true);
    expect(root.querySelector('.sid-stale')?.textContent).toBe('暂时无法刷新，显示的是上次的数据');
    expect(rows(root)).toHaveLength(4);
  });

  it('leaves out the disk and GPU rows the device does not report, and stays hidden without a reading', async () => {
    deviceStats.stats.value = reading({ disk: undefined, gpus: [], cpu: { cores: 8, limited: false } });
    const root = mount({ deviceId: 'gpu-box' });
    expect(rows(root)).toEqual([
      ['CPU', '—', ''],
      ['内存', '50%', ''],
    ]);

    deviceStats.stats.value = null;
    await nextTick();
    expect(root.querySelector('.si-device')).toBeNull();
  });
});
