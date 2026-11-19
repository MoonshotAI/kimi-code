// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppSessionWorktree } from '@moonshot-ai/app-core/api';

const worktree = ref<AppSessionWorktree | undefined>(undefined);
const actions = {
  retrySessionWorktree: vi.fn(async () => true),
  cancelSessionWorktree: vi.fn(async () => true),
  useLocalForSessionWorktree: vi.fn(async () => true),
  skipSessionWorktreeScript: vi.fn(async () => true),
  runSessionWorktreeScript: vi.fn(async () => true),
  recreateSessionWorktree: vi.fn(async () => true),
};

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    useKimiWebClient: () => ({
      goal: ref(null),
      planMode: ref(false),
      planArmed: ref(false),
      status: ref({ cwd: '/workspace' }),
      activeSessionId: ref('s1'),
      activeSessionWorktree: worktree,
      controlGoal: vi.fn(),
      togglePlanMode: vi.fn(),
      cancelTask: vi.fn(),
      dismissQuestion: vi.fn(),
      ...actions,
    }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return {
    ...actual,
    useConfirmDialog: () => ({ confirm: vi.fn(), isConfirmOpen: ref(false) }),
    useAppDialogs: () => ({ anyOverlayOpen: ref(false) }),
  };
});

vi.mock('@moonshot-ai/app-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core')>();
  return { ...actual, useAppearance: () => ({ fontScale: ref('medium') }) };
});

vi.mock('@moonshot-ai/app-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-components')>();
  const vue = await import('vue');
  return { ...actual, Composer: { render: () => vue.h('div', { class: 'composer-stub' }) } };
});

vi.mock('@moonshot-ai/app-markdown', () => ({ Markdown: { render: () => null } }));

import { registerWorktreeSettingsOpener } from '@moonshot-ai/app-client/composables';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { worktreeSetup } from '@moonshot-ai/app-client/testing';
import DesktopChatDock from '../../src/renderer/components/chat/ChatDock.vue';

let app: App | null = null;
let host: HTMLDivElement;

async function mountDock(): Promise<void> {
  app = createApp({
    render: () =>
      h(DesktopChatDock, {
        dockPanel: null,
        bashTasks: [],
        subagentTasks: [],
        bashRunning: 0,
        subagentRunning: 0,
        todoDoneCount: 0,
        hasDockWork: false,
        todos: [],
      }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(panelApiKey, undefined);
  app.mount(host);
  await nextTick();
}

async function press(action: string): Promise<void> {
  const found = host.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (!found) throw new Error(`Missing action: ${action}`);
  found.click();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

const composer = () => host.querySelector<HTMLElement>('.composer-stub')!;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  for (const mock of Object.values(actions)) mock.mockClear();
  worktree.value = undefined;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('desktop ChatDock worktree cards', () => {
  it('keeps the composer below a decision card and maps its buttons to worktree actions', async () => {
    worktree.value = { setup: worktreeSetup({ status: 'failed', failure: { kind: 'fetch_failed' } }) };
    await mountDock();

    const card = host.querySelector<HTMLElement>('[data-worktree-card="fetchFailed"]')!;
    expect(card).not.toBeNull();
    expect(composer().style.display).toBe('');
    expect(card.compareDocumentPosition(composer()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await press('retry');
    expect(actions.retrySessionWorktree).toHaveBeenLastCalledWith('s1');
    await press('createFromLocal');
    expect(actions.retrySessionWorktree).toHaveBeenLastCalledWith('s1', { useRemote: false });

    worktree.value = {
      setup: worktreeSetup({ status: 'failed', failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['a.ts'] } }),
    };
    await nextTick();
    await press('createFromRemote');
    expect(actions.retrySessionWorktree).toHaveBeenLastCalledWith('s1', { useRemote: true, includeLocalChanges: false });

    const openSettings = vi.fn();
    registerWorktreeSettingsOpener(openSettings);
    worktree.value = { setup: worktreeSetup({ status: 'failed', failure: { kind: 'disk_full' } }) };
    await nextTick();
    await press('manage');
    expect(openSettings).toHaveBeenCalledTimes(1);
    await press('useLocal');
    expect(actions.useLocalForSessionWorktree).toHaveBeenCalledWith('s1');
  });

  it('maps the script cards to skip and run', async () => {
    worktree.value = {
      path: '/w',
      setup: worktreeSetup({ status: 'awaiting_script_confirmation', script: 'pending', scriptContent: 'pnpm install' }),
    };
    await mountDock();
    expect(host.querySelector('[data-worktree-card="scriptConfirm"] .wcc-code')?.textContent).toBe('pnpm install');
    await press('runScript');
    expect(actions.runSessionWorktreeScript).toHaveBeenCalledWith('s1');

    worktree.value = {
      path: '/w',
      setup: worktreeSetup({ status: 'failed', stoppedStep: 'script', failure: { kind: 'script_failed', exitCode: 1 } }),
    };
    await nextTick();
    await press('skipScript');
    expect(actions.skipSessionWorktreeScript).toHaveBeenCalledWith('s1');
    expect(actions.retrySessionWorktree).not.toHaveBeenCalled();
  });

  it('replaces the composer with the invalid card and recreates inside it', async () => {
    worktree.value = { path: '/w', branch: 'kimi/1', missing: true, setup: worktreeSetup() };
    await mountDock();

    expect(host.querySelector('[data-worktree-invalid="missing"]')).not.toBeNull();
    expect(host.querySelector('[data-worktree-card]')).toBeNull();
    expect(composer().style.display).toBe('none');
    await press('recreate');
    expect(actions.recreateSessionWorktree).toHaveBeenCalledWith('s1');

    worktree.value = {
      branch: 'kimi/1',
      missing: true,
      setup: worktreeSetup({ purpose: 'recreate', status: 'running', steps: [{ kind: 'create', state: 'running', command: 'git worktree add /w kimi/1' }] }),
    };
    await nextTick();
    expect(host.querySelector('[data-worktree-invalid="recreating"] .wci-command')?.textContent).toBe('git worktree add /w kimi/1');
    expect(composer().style.display).toBe('none');
    await press('stop');
    expect(actions.cancelSessionWorktree).toHaveBeenCalledWith('s1');

    worktree.value = { branch: 'kimi/1', missing: true, setup: worktreeSetup({ purpose: 'recreate', status: 'stopped', stoppedStep: 'create' }) };
    await nextTick();
    expect(host.querySelector('[data-worktree-invalid="stopped"]')).not.toBeNull();
    await press('retry');
    expect(actions.retrySessionWorktree).toHaveBeenLastCalledWith('s1');

    worktree.value = { path: '/w', branch: 'kimi/1', setup: worktreeSetup({ purpose: 'recreate' }) };
    await nextTick();
    expect(host.querySelector('[data-worktree-invalid]')).toBeNull();
    expect(composer().style.display).toBe('');
  });
});
