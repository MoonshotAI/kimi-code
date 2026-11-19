// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { devicesStore } from '@moonshot-ai/app-client/stores';

import WorkspaceHoverCard from '../src/sidebar/WorkspaceHoverCard.vue';
import { useWorkspaceHoverCard } from '../src/sidebar/useWorkspaceHoverCard';

const workspace: WorkspaceView = {
  id: 'ws1',
  name: 'code-app',
  root: '/repo/code-app',
  shortPath: '~/repo/code-app',
  additionalDirs: ['/repo/docs', '/repo/packages'],
  sessionCount: 3,
};

let app: App | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useWorkspaceHoverCard', () => {
  it('opens after 500ms, cancels an early leave and switches workspaces', () => {
    const scope = effectScope();
    const hover = scope.run(() => useWorkspaceHoverCard())!;
    const anchor = { right: 220, top: 160 };

    hover.scheduleOpen(workspace, anchor);
    vi.advanceTimersByTime(499);
    expect(hover.workspace.value).toBeNull();
    hover.scheduleClose();
    vi.advanceTimersByTime(1);
    expect(hover.workspace.value).toBeNull();

    hover.scheduleOpen(workspace, anchor);
    vi.advanceTimersByTime(500);
    expect(hover.workspace.value?.id).toBe('ws1');
    expect(hover.cardStyle.value.left).toBe('232px');
    expect(hover.cardStyle.value.maxWidth).toBe('460px');
    expect(hover.cardStyle.value.width).toBeUndefined();

    hover.scheduleOpen({ ...workspace, id: 'ws2', name: 'other' }, anchor);
    vi.advanceTimersByTime(500);
    expect(hover.workspace.value?.id).toBe('ws2');
    hover.scheduleClose();
    vi.advanceTimersByTime(139);
    expect(hover.workspace.value).not.toBeNull();
    hover.cancelClose();
    vi.advanceTimersByTime(500);
    expect(hover.workspace.value).not.toBeNull();
    hover.scheduleClose();
    vi.advanceTimersByTime(140);
    expect(hover.workspace.value).toBeNull();
    scope.stop();
  });
});

describe('WorkspaceHoverCard', () => {
  it('renders only the project name and ordered full directory paths', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const emitted = vi.fn();
    app = createApp({ render: () => h(WorkspaceHoverCard, { workspace, canOpen: true, onOpenDirectory: emitted }) });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.whc-directory')];
    expect(host.textContent).toContain('code-app');
    expect(buttons.map(button => button.querySelector('.whc-path')?.textContent)).toEqual([
      '/repo/code-app',
      '/repo/docs',
      '/repo/packages',
    ]);
    expect(host.textContent).not.toContain('个任务');
    expect(host.textContent).not.toContain('未读');
    expect(host.textContent).not.toContain('活跃');
    expect(host.textContent).not.toContain('置顶');
    expect(host.querySelector('.whc-count')).toBeNull();
    expect(host.querySelector('.whc-foot')).toBeNull();
    expect(host.querySelector('.whc-open')).toBeNull();
    expect(host.querySelector('.whc-head .kw-icon')).toBeNull();
    expect(buttons.every(button => button.title === '')).toBe(true);
    buttons[1]!.click();
    expect(emitted).toHaveBeenCalledExactlyOnceWith('/repo/docs');
  });

  it('keeps paths readable but disabled when opening is unavailable', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(WorkspaceHoverCard, { workspace, canOpen: false });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.whc-directory')];
    expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.disabled)).toBe(true);
    expect(buttons[0]?.textContent).toContain('/repo/code-app');
  });

  function mountRemote(emitted = vi.fn()): HTMLDivElement {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () => h(WorkspaceHoverCard, {
        workspace: {
          ...workspace,
          root: '/srv/app',
          deviceId: 'devbox',
          additionalDirs: [],
        },
        canOpen: true,
        onOpenDirectory: emitted,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    return host;
  }

  afterEach(() => {
    devicesStore().byId = {};
    devicesStore().loaded = false;
  });

  it('shows the device and its state together, above a plain remote path', async () => {
    devicesStore().byId = { devbox: { id: 'devbox', connection: 'ssh', name: 'Build box', host: 'devbox', status: 'ready' } };
    devicesStore().loaded = true;
    const emitted = vi.fn();
    const card = mountRemote(emitted);
    await nextTick();

    expect(card.querySelector('.whc-head')?.textContent?.trim()).toBe('code-app');
    expect(card.querySelector('.whc-device-name')?.textContent).toBe('Build box');
    expect(card.querySelector('.whc-device-state')).not.toBeNull();
    expect(card.querySelector('.whc-path')?.textContent).toBe('/srv/app');
    expect(card.querySelector('button')).toBeNull();
    card.querySelector<HTMLElement>('.whc-directory--static')!.click();
    expect(emitted).not.toHaveBeenCalled();
  });

  it('names the reason next to the device when the connection failed', async () => {
    devicesStore().byId = { devbox: { id: 'devbox', connection: 'ssh', host: 'devbox', status: 'disconnected', connectError: 'raw', connectFailure: 'connection_refused' } };
    devicesStore().loaded = true;
    const card = mountRemote();
    await nextTick();

    const states = [...card.querySelectorAll('.whc-device-state')];
    expect(states).toHaveLength(2);
    expect(states[1]?.textContent?.trim()).not.toBe('');
    expect(card.querySelector('.whc-device-state.failed')).not.toBeNull();
  });

  it('names an offline account device by its alias and shows only its state', async () => {
    devicesStore().byId = {
      devbox: { id: 'devbox', connection: 'account', alias: 'Work Mac', status: 'disconnected', connectError: 'offline', connectFailure: 'offline' },
    };
    devicesStore().loaded = true;
    const card = mountRemote();
    await nextTick();

    expect(card.querySelector('.whc-device-name')?.textContent).toBe('Work Mac');
    expect([...card.querySelectorAll('.whc-device-state')].map((state) => state.textContent?.trim())).toEqual(['Offline']);
    expect(card.querySelector('.ws-icon')?.getAttribute('aria-label')).toBe('Work Mac · Offline');
  });
});
