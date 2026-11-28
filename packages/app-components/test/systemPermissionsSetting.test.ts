// @vitest-environment jsdom
import { computed, createApp, h, nextTick, ref, shallowRef, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';
import type { SystemPermissionId, SystemPermissionItem, SystemPermissionsSnapshot } from '@moonshot-ai/app-core/lib';
import type { useSystemPermissions } from '@moonshot-ai/app-client/composables';

const fakes = vi.hoisted(() => ({
  current: null as unknown as ReturnType<typeof useSystemPermissions>,
}));

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return { ...actual, useSystemPermissions: () => fakes.current };
});

import SystemPermissionsSetting from '../src/settings/SystemPermissionsSetting.vue';
import { systemPermissionExtraHintKey } from '../src/settings/systemPermissionsLabels';

let app: App | null = null;
let host: HTMLDivElement;

function item(id: SystemPermissionId, status: SystemPermissionItem['status'], action: SystemPermissionItem['action'], requiresRestart = false): SystemPermissionItem {
  return { id, status, action, requiresRestart };
}

function makeController(items: SystemPermissionItem[], computerUseInstalled = false) {
  const snap = shallowRef<SystemPermissionsSnapshot | null>({ platform: 'darwin', computerUseInstalled, items });
  return {
    snapshot: snap,
    loading: ref(false),
    busyId: ref<SystemPermissionId | null>(null),
    error: ref<string | null>(null),
    hostItems: computed(() => snap.value?.items.filter((entry) => !entry.id.startsWith('cu-')) ?? []),
    computerUseItems: computed(() => snap.value?.computerUseInstalled ? snap.value.items.filter((entry) => entry.id.startsWith('cu-')) : []),
    refresh: vi.fn(async () => {}),
    runAction: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountPage(locale: 'zh' | 'en' = 'zh'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ render: () => h(SystemPermissionsSetting) });
  app.use(createKimiI18n({ locale }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

describe('systemPermissionExtraHintKey', () => {
  it('returns hints only for the matching permission and state', () => {
    expect(systemPermissionExtraHintKey(item('screen-recording', 'denied', 'open-settings', true))).toBe('settings.systemPermissions.screenRecordingRestartHint');
    expect(systemPermissionExtraHintKey(item('screen-recording', 'granted', null))).toBeNull();
    expect(systemPermissionExtraHintKey(item('notifications', 'denied', 'open-settings'))).toBe('settings.systemPermissions.notificationsSettingsHint');
    expect(systemPermissionExtraHintKey(item('local-network', 'unavailable', null))).toBe('settings.systemPermissions.localNetworkUnavailableHint');
    expect(systemPermissionExtraHintKey(item('microphone', 'denied', 'open-settings'))).toBeNull();
  });
});

describe('SystemPermissionsSetting', () => {
  it('shows the entry row first, then loads and renders both permission groups in Chinese', async () => {
    const controller = makeController([
      item('local-network', 'not-determined', 'request'),
      item('screen-recording', 'denied', 'open-settings', true),
      item('notifications', 'denied', 'open-settings'),
      item('files-and-folders', 'on-demand', 'open-settings'),
      item('cu-accessibility', 'granted', null),
      item('cu-screen-recording', 'not-determined', 'request'),
    ], true);
    fakes.current = controller;
    await mountPage('zh');
    expect(host.querySelector('[data-settings-subpage-origin="systemPermissions"]')).not.toBeNull();
    expect(controller.refresh).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="systemPermissions"]')!.click();
    await flush();
    expect(controller.refresh).toHaveBeenCalledOnce();

    expect(host.textContent).toContain('Kimi Code 应用权限');
    expect(host.textContent).toContain('Computer Use 插件权限');
    expect(host.textContent).toContain('开启后需重启应用生效');
    expect(host.textContent).toContain('在系统设置的通知列表中找到 Kimi Code 并开启通知');
    expect(host.textContent).toContain('按需请求');
    expect(host.textContent).not.toContain('完全磁盘访问');

    const localRow = host.querySelector<HTMLElement>('[data-permission-id="local-network"]')!;
    localRow.querySelector('button')!.click();
    await flush();
    expect(controller.runAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'local-network', action: 'request' }));

    const cuGranted = host.querySelector<HTMLElement>('[data-permission-id="cu-accessibility"]')!;
    expect(cuGranted.querySelector('button')).toBeNull();
    expect(cuGranted.textContent).toContain('已允许');
  });

  it('hides the Computer Use group when not installed and renders English sentence-case labels', async () => {
    fakes.current = makeController([
      item('local-network', 'granted', null),
      item('camera', 'not-determined', 'request'),
      item('cu-accessibility', 'granted', null),
    ], false);
    await mountPage('en');
    host.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="systemPermissions"]')!.click();
    await flush();
    expect(host.textContent).toContain('System permissions');
    expect(host.textContent).toContain('Request permission');
    expect(host.textContent).not.toContain('Computer Use plugin permissions');
    expect(host.querySelector('[data-permission-id="cu-accessibility"]')).toBeNull();
  });

  it('shows a retry state when the initial load fails', async () => {
    const controller = makeController([]);
    controller.snapshot.value = null;
    controller.loading.value = false;
    controller.error.value = 'ipc failed';
    fakes.current = controller;
    await mountPage('zh');
    host.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="systemPermissions"]')!.click();
    await flush();
    expect(host.textContent).toContain('权限状态读取失败，请重试');
    const buttons = [...host.querySelectorAll('button')];
    buttons.find((button) => button.textContent?.includes('重试'))!.click();
    await flush();
    expect(controller.refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
