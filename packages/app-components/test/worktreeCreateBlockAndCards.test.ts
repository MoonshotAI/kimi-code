// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppSessionWorktree, AppWorktreeSetup, AppWorktreeSetupStep } from '@moonshot-ai/app-core/api';
import CreateDecisionCard from '../src/worktree/CreateDecisionCard.vue';
import CreateInvalidCard from '../src/worktree/CreateInvalidCard.vue';
import CreateProgressBlock from '../src/worktree/CreateProgressBlock.vue';
import { forgetCreateRuns } from '../src/worktree/createBlockMemory';
import {
  createDecisionCardView,
  createInvalidCardView,
  type CreateTranslate,
} from '../src/worktree/createPresentation';

const t = createKimiI18n({ locale: 'en' }).global.t as unknown as CreateTranslate;

let app: App | null = null;
let host: HTMLDivElement;

function mount(component: Component, props: Record<string, unknown>): HTMLDivElement {
  app = createApp({ render: () => h(component, props) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host;
}

function setup(overrides: Partial<AppWorktreeSetup> = {}): AppWorktreeSetup {
  return {
    status: 'ready',
    purpose: 'create',
    request: { sourceBranch: 'main' },
    steps: [],
    commandsRan: 0,
    startedAt: '2026-11-18T10:00:00.000Z',
    script: 'none',
    ...overrides,
  };
}

function step(kind: AppWorktreeSetupStep['kind'], state: AppWorktreeSetupStep['state'], extra: Partial<AppWorktreeSetupStep> = {}): AppWorktreeSetupStep {
  return { kind, state, ...extra };
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

const text = (selector: string) => host.querySelector(selector)?.textContent?.trim();
const stepRows = () => [...host.querySelectorAll<HTMLElement>('.wcb-step')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  forgetCreateRuns();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.useRealTimers();
});

describe('CreateProgressBlock', () => {
  it('shows elapsed seconds and every step while running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T10:00:05.000Z'));
    const worktree: AppSessionWorktree = {
      setup: setup({
        status: 'running',
        steps: [
          step('fetch', 'done', { ref: 'origin/main', command: 'git fetch --no-tags origin main' }),
          step('create', 'running', { ref: 'origin/main', command: 'git worktree add --no-track -b kimi/1 /w origin/main' }),
          step('script', 'pending'),
        ],
      }),
    };
    mount(CreateProgressBlock, { worktree, sessionId: 's1' });
    await nextTick();

    expect(text('.wcb-title')).toBe('Creating Worktree');
    expect(text('.wcb-elapsed')).toBe('5 s');
    expect(host.querySelector('.wcb-head svg[data-icon="check"], .wcb-head svg[data-icon="alert-triangle"]')).toBeNull();
    expect(stepRows().map((row) => [row.dataset.state, row.querySelector('.wcb-label')?.textContent])).toEqual([
      ['done', 'Fetched origin/main'],
      ['running', 'Creating Worktree from origin/main'],
      ['pending', 'Run initialization script'],
    ]);
    expect(stepRows()[0]?.querySelector('.wcb-command')?.textContent).toBe('git fetch --no-tags origin main');
    expect(stepRows()[0]?.querySelector('svg[data-icon="check"]')).not.toBeNull();
    expect(stepRows()[2]?.querySelector('.wcb-dot')).not.toBeNull();
    expect(stepRows()[2]?.querySelector('.wcb-command')).toBeNull();

    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(text('.wcb-elapsed')).toBe('7 s');
  });

  it('collapses when created and expands on demand', async () => {
    const worktree: AppSessionWorktree = {
      path: '/w',
      includedLocalChanges: true,
      setup: setup({ commandsRan: 2, steps: [step('create', 'done', { ref: 'main', command: 'git worktree add /w main' }), step('changes', 'done')] }),
    };
    mount(CreateProgressBlock, { worktree, sessionId: 's1' });
    await nextTick();

    expect(text('.wcb-title')).toBe('Worktree created');
    expect(text('.wcb-meta')).toBe('2 commands ran');
    expect(text('.wcb-note')).toContain('Local uncommitted changes were included');
    expect(stepRows()).toHaveLength(0);

    host.querySelector<HTMLButtonElement>('.wcb-head')!.click();
    await nextTick();
    expect(stepRows().map((row) => row.querySelector('.wcb-label')?.textContent)).toEqual([
      'Worktree created from main',
      'Local uncommitted changes included',
    ]);
  });

  it('auto-expands with the failed step in red and its output', async () => {
    const state = reactive<{ worktree: AppSessionWorktree }>({
      worktree: { setup: setup({ status: 'running', steps: [step('fetch', 'running', { ref: 'origin/main', command: 'git fetch' })] }) },
    });
    app = createApp({ render: () => h(CreateProgressBlock, { worktree: state.worktree, sessionId: 's1' }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);
    await nextTick();
    host.querySelector<HTMLButtonElement>('.wcb-head')!.click();
    await nextTick();
    expect(stepRows()).toHaveLength(0);

    state.worktree = {
      setup: setup({
        status: 'failed',
        failure: { kind: 'fetch_failed' },
        commandsRan: 1,
        steps: [step('fetch', 'failed', { ref: 'origin/main', command: 'git fetch', output: 'fatal: Could not resolve host' })],
      }),
    };
    await nextTick();

    expect(text('.wcb-title')).toBe('Remote fetch failed');
    expect(text('.wcb-meta')).toBe('1 command ran');
    const failed = stepRows()[0]!;
    expect(failed.classList.contains('is-failed')).toBe(true);
    expect(failed.querySelector('svg[data-icon="alert-triangle"]')).not.toBeNull();
    expect(failed.querySelector('.wcb-output')?.textContent).toBe('fatal: Could not resolve host');
  });

  it('keeps showing the original creation while the worktree is recreated', async () => {
    const state = reactive<{ worktree: AppSessionWorktree }>({
      worktree: { path: '/w', setup: setup({ commandsRan: 1, steps: [step('create', 'done', { ref: 'main' })] }) },
    });
    app = createApp({ render: () => h(CreateProgressBlock, { worktree: state.worktree, sessionId: 's1' }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);
    await nextTick();

    state.worktree = {
      branch: 'kimi/1',
      missing: true,
      setup: setup({ purpose: 'recreate', status: 'running', steps: [step('prune', 'running'), step('create', 'pending')] }),
    };
    await nextTick();

    expect(text('.wcb-title')).toBe('Worktree created');
    expect(text('.wcb-meta')).toBe('1 command ran');
    expect(host.querySelector('.wcb-elapsed')).toBeNull();
    expect(stepRows()).toHaveLength(0);
  });
});

describe('CreateDecisionCard', () => {
  it('renders the problem, the body and the buttons with the primary one last', async () => {
    const onAction = vi.fn();
    const view = createDecisionCardView({ setup: setup({ status: 'failed', failure: { kind: 'disk_full' } }) }, t)!;
    mount(CreateDecisionCard, { view, onAction });
    await nextTick();

    expect(text('.wcc-title')).toBe('Worktree creation failed');
    expect(text('.wcc-text')).toContain('Insufficient disk space');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.wcc-actions button')];
    expect(buttons.map((item) => item.dataset.action)).toEqual(['manage', 'useLocal', 'retry']);
    expect(buttons.at(-1)?.classList.contains('ui-button--primary')).toBe(true);
    expect(buttons[0]?.classList.contains('ui-button--secondary')).toBe(true);

    button('Use Local Mode').click();
    button('Manage').click();
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(['useLocal', 'manage']);
  });

  it('lists conflict files and shows the script to confirm', async () => {
    const conflict = createDecisionCardView(
      { setup: setup({ status: 'failed', failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['src/a.ts', 'src/b.ts'] } }) },
      t,
    )!;
    mount(CreateDecisionCard, { view: conflict });
    await nextTick();
    expect([...host.querySelectorAll('.wcc-file')].map((item) => item.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
    app?.unmount();

    const confirm = createDecisionCardView(
      { path: '/w', setup: setup({ status: 'awaiting_script_confirmation', script: 'pending', scriptContent: 'pnpm install' }) },
      t,
    )!;
    mount(CreateDecisionCard, { view: confirm });
    await nextTick();
    expect(text('.wcc-code')).toBe('pnpm install');
    expect([...host.querySelectorAll<HTMLButtonElement>('.wcc-actions button')].map((item) => item.dataset.action)).toEqual([
      'skipScript',
      'runScript',
    ]);
  });

  it('runs the primary action on Enter outside editable fields and blocks actions while busy', async () => {
    const onAction = vi.fn();
    const view = createDecisionCardView({ setup: setup({ status: 'failed', failure: { kind: 'fetch_failed' } }) }, t)!;
    const state = reactive<{ busy: string | null }>({ busy: null });
    app = createApp({ render: () => h(CreateDecisionCard, { view, busyAction: state.busy as never, onAction }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);
    await nextTick();

    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onAction).not.toHaveBeenCalled();
    input.remove();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onAction).toHaveBeenCalledWith('retry');

    state.busy = 'retry';
    await nextTick();
    onAction.mockClear();
    expect([...host.querySelectorAll<HTMLButtonElement>('.wcc-actions button')].every((item) => item.disabled)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('CreateInvalidCard', () => {
  it('offers recreate and local mode for a missing worktree', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView({ path: '/w', branch: 'kimi/1', missing: true, setup: setup() }, t)!;
    mount(CreateInvalidCard, { view, onAction });
    await nextTick();

    expect(text('.wci-title')).toBe('Worktree no longer exists');
    expect(text('.wci-body')).toBe('You can recreate it from branch kimi/1 or switch to Local mode.');
    button('Recreate Worktree').click();
    button('Use Local Mode').click();
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(['recreate', 'useLocal']);
  });

  it('shows the running command with a stop button while recreating', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView(
      {
        branch: 'kimi/1',
        missing: true,
        setup: setup({ purpose: 'recreate', status: 'running', steps: [step('prune', 'done'), step('create', 'running', { command: 'git worktree add /w kimi/1' })] }),
      },
      t,
    )!;
    mount(CreateInvalidCard, { view, onAction });
    await nextTick();

    expect(text('.wci-title')).toBe('Recreating Worktree from kimi/1');
    expect(text('.wci-command')).toBe('git worktree add /w kimi/1');
    expect(host.querySelectorAll('.wci-actions button')).toHaveLength(1);
    button('Stop').click();
    expect(onAction).toHaveBeenCalledWith('stop');
  });

  it('toggles the raw output of a failed recreate without emitting', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView(
      {
        branch: 'kimi/1',
        missing: true,
        setup: setup({
          purpose: 'recreate',
          status: 'failed',
          failure: { kind: 'disk_full' },
          steps: [step('create', 'failed', { command: 'git worktree add /w kimi/1', output: 'No space left on device' })],
        }),
      },
      t,
    )!;
    mount(CreateInvalidCard, { view, onAction });
    await nextTick();

    expect(text('.wci-title')).toBe('Worktree recreation failed');
    expect([...host.querySelectorAll<HTMLButtonElement>('.wci-actions button')].map((item) => item.dataset.action)).toEqual([
      'viewOutput',
      'manage',
      'useLocal',
      'retry',
    ]);
    expect(host.querySelector('.wci-output')).toBeNull();
    button('View Raw Output').click();
    await nextTick();
    expect(text('.wci-output')).toBe('git worktree add /w kimi/1\nNo space left on device');
    expect(onAction).not.toHaveBeenCalled();
    button('Hide Raw Output').click();
    await nextTick();
    expect(host.querySelector('.wci-output')).toBeNull();
  });
});
