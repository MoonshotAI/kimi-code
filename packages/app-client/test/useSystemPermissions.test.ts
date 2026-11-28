import { describe, expect, it, vi } from 'vitest';
import { createSystemPermissionsController } from '../src/composables/useSystemPermissions';
import type { SystemPermissionsSnapshot } from '@moonshot-ai/app-core/lib';

function snapshot(overrides: Partial<SystemPermissionsSnapshot> = {}): SystemPermissionsSnapshot {
  return {
    platform: 'darwin',
    computerUseInstalled: false,
    items: [
      { id: 'local-network', status: 'not-determined', action: 'request', requiresRestart: false },
      { id: 'notifications', status: 'not-determined', action: 'request', requiresRestart: false },
    ],
    ...overrides,
  };
}

function fakeFocusTarget() {
  const listeners = new Map<string, () => void>();
  return {
    addEventListener: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
    removeEventListener: vi.fn((event: string) => listeners.delete(event)),
    emit: (event: string) => listeners.get(event)?.(),
    size: () => listeners.size,
  };
}

describe('createSystemPermissionsController', () => {
  it('loads host permissions and hides Computer Use rows when the plugin is not installed', async () => {
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot()),
      requestSystemPermission: vi.fn(),
      openSystemPermissionSettings: vi.fn(),
    };
    const controller = createSystemPermissionsController({
      bridge,
      listPlugins: async () => [{ id: 'other-plugin' }],
      notifications: { syncPermission: () => 'default', requestPermission: async () => 'default' },
    });
    await controller.refresh();
    expect(bridge.getSystemPermissions).toHaveBeenCalledWith({ computerUseInstalled: false, notificationPermission: 'default' });
    expect(controller.hostItems.value.map((item) => item.id)).toEqual(['local-network', 'notifications']);
    expect(controller.computerUseItems.value).toEqual([]);
    expect(controller.loading.value).toBe(false);
    controller.dispose();
  });

  it('separates Computer Use items when kimi-cu is installed', async () => {
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot({
        computerUseInstalled: true,
        items: [
          ...snapshot().items,
          { id: 'cu-accessibility', status: 'granted', action: null, requiresRestart: false },
        ],
      })),
      requestSystemPermission: vi.fn(),
      openSystemPermissionSettings: vi.fn(),
    };
    const controller = createSystemPermissionsController({
      bridge,
      listPlugins: async () => [{ id: 'kimi-cu' }],
      notifications: { syncPermission: () => 'granted', requestPermission: async () => 'granted' },
    });
    await controller.refresh();
    expect(controller.hostItems.value.map((item) => item.id)).toEqual(['local-network', 'notifications']);
    expect(controller.computerUseItems.value.map((item) => item.id)).toEqual(['cu-accessibility']);
    controller.dispose();
  });

  it('refreshes on window focus and unsubscribes on dispose', async () => {
    const focusTarget = fakeFocusTarget();
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot()),
      requestSystemPermission: vi.fn(),
      openSystemPermissionSettings: vi.fn(),
    };
    const controller = createSystemPermissionsController({
      bridge,
      focusTarget,
      listPlugins: async () => [],
      notifications: { syncPermission: () => 'default', requestPermission: async () => 'default' },
    });
    await controller.refresh();
    focusTarget.emit('focus');
    await vi.waitFor(() => expect(bridge.getSystemPermissions).toHaveBeenCalledTimes(2));
    controller.dispose();
    expect(focusTarget.size()).toBe(0);
  });

  it('requests notification permission in the renderer before refreshing', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    const syncPermission = vi.fn(() => 'granted');
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot({
        items: [{ id: 'notifications', status: 'granted', action: null, requiresRestart: false }],
      })),
      requestSystemPermission: vi.fn(),
      openSystemPermissionSettings: vi.fn(),
    };
    const controller = createSystemPermissionsController({
      bridge,
      listPlugins: async () => [],
      notifications: { syncPermission, requestPermission },
    });
    await controller.runAction({ id: 'notifications', status: 'not-determined', action: 'request', requiresRestart: false });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(bridge.requestSystemPermission).not.toHaveBeenCalled();
    expect(bridge.getSystemPermissions).toHaveBeenCalledOnce();
    expect(controller.snapshot.value?.items[0]?.status).toBe('granted');
    controller.dispose();
  });

  it('routes request and open-settings actions through the bridge and guards concurrent clicks', async () => {
    const next = snapshot({ items: [{ id: 'local-network', status: 'granted', action: null, requiresRestart: false }] });
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot()),
      requestSystemPermission: vi.fn(async () => next),
      openSystemPermissionSettings: vi.fn(async () => next),
    };
    const controller = createSystemPermissionsController({
      bridge,
      listPlugins: async () => [],
      notifications: { syncPermission: () => 'default', requestPermission: async () => 'default' },
    });
    const item = { id: 'local-network' as const, status: 'not-determined' as const, action: 'request' as const, requiresRestart: false };
    await Promise.all([controller.runAction(item), controller.runAction(item)]);
    expect(bridge.requestSystemPermission).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.value?.items[0]?.status).toBe('granted');
    await controller.runAction({ ...item, status: 'denied', action: 'open-settings' });
    expect(bridge.openSystemPermissionSettings).toHaveBeenCalledTimes(1);
    await controller.runAction({ ...item, status: 'granted', action: null });
    expect(bridge.requestSystemPermission).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('surfaces bridge errors without losing the previous snapshot', async () => {
    const bridge = {
      getSystemPermissions: vi.fn(async () => snapshot()),
      requestSystemPermission: vi.fn(async () => { throw new Error('probe failed'); }),
      openSystemPermissionSettings: vi.fn(),
    };
    const controller = createSystemPermissionsController({
      bridge,
      listPlugins: async () => [],
      notifications: { syncPermission: () => 'default', requestPermission: async () => 'default' },
    });
    await controller.refresh();
    await controller.runAction({ id: 'local-network', status: 'not-determined', action: 'request', requiresRestart: false });
    expect(controller.error.value).toBe('probe failed');
    expect(controller.snapshot.value).not.toBeNull();
    expect(controller.busyId.value).toBeNull();
    controller.dispose();
  });
});
