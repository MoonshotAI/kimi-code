// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { sessionWorktree } from '@moonshot-ai/app-client/testing';
import type { AppSessionWorktree, AppWorktreeSetupStep } from '@moonshot-ai/app-core/api';
import CreateDecisionCard from '../src/worktree/CreateDecisionCard.vue';
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

function mount(component: Component, props: Record<string, unknown> | (() => Record<string, unknown>)): HTMLDivElement {
  const read = typeof props === 'function' ? props : () => props;
  app = createApp({ render: () => h(component, read()) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host;
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
  it('counts the running command and links reached steps', async () => {
    const worktree = sessionWorktree('running', {}, {
      commandsRan: 1,
      steps: [
        step('fetch', 'done', { ref: 'origin/main', command: 'git fetch --no-tags origin main' }),
        step('create', 'running', { ref: 'origin/main', command: 'git worktree add --no-track -b kimi/1 /w origin/main' }),
        step('changes', 'pending', { command: 'git cherry-pick --no-commit abc' }),
      ],
    });
    mount(CreateProgressBlock, { worktree, sessionId: 's1' });
    await nextTick();

    expect(text('.wcb-title')).toBe('Creating Worktree');
    expect(text('.wcb-meta')).toBe('2 commands ran');
    expect(host.querySelector('.wcb-head svg[data-icon="chevron-down"]')).not.toBeNull();
    expect(stepRows().map((row) => row.dataset.state)).toEqual(['done', 'running', 'pending']);
    expect(stepRows().map((row) => row.classList.contains('connected'))).toEqual([true, false, false]);
    expect(stepRows()[0]?.querySelector('svg[data-icon="check"]')).not.toBeNull();
    expect(stepRows()[2]?.querySelector('.wcb-circle')).not.toBeNull();
    expect(stepRows()[2]?.querySelector('.wcb-command')?.textContent).toBe('git cherry-pick --no-commit abc');
  });

  it('collapses when created and expands on demand', async () => {
    const worktree = sessionWorktree(
      'ready',
      { path: '/w', includedLocalChanges: true },
      { commandsRan: 2, steps: [step('create', 'done', { ref: 'main', command: 'git worktree add /w main' }), step('changes', 'done')] },
    );
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
      worktree: sessionWorktree('running', {}, { steps: [step('fetch', 'running', { ref: 'origin/main', command: 'git fetch' })] }),
    });
    mount(CreateProgressBlock, () => ({ worktree: state.worktree, sessionId: 's1' }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.wcb-head')!.click();
    await nextTick();
    expect(stepRows()).toHaveLength(0);

    state.worktree = sessionWorktree('failed', {}, {
      failure: { kind: 'fetch_failed' },
      commandsRan: 1,
      steps: [step('fetch', 'failed', { ref: 'origin/main', command: 'git fetch', output: 'fatal: Could not resolve host' })],
    });
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
      worktree: sessionWorktree('ready', { path: '/w' }, { commandsRan: 1, steps: [step('create', 'done', { ref: 'main' })] }),
    });
    mount(CreateProgressBlock, () => ({ worktree: state.worktree, sessionId: 's1' }));
    await nextTick();

    state.worktree = sessionWorktree(
      'running',
      { branch: 'kimi/1', missing: true },
      { purpose: 'recreate', steps: [step('prune', 'running'), step('create', 'pending')] },
    );
    await nextTick();

    expect(text('.wcb-title')).toBe('Worktree created');
    expect(text('.wcb-meta')).toBe('1 command ran');
    expect(stepRows()).toHaveLength(0);
  });
});

describe('CreateDecisionCard', () => {
  it('renders the problem, the body and the buttons with the primary one last', async () => {
    const onAction = vi.fn();
    const view = createDecisionCardView(sessionWorktree('failed', {}, { failure: { kind: 'disk_full' } }), t)!;
    mount(CreateDecisionCard, { view, onAction });
    await nextTick();

    expect(text('.akind')).toBe('Worktree creation failed');
    expect(text('.wcc-text')).toContain('Insufficient disk space');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.abtns button')];
    expect(buttons.map((item) => item.dataset.action)).toEqual(['manage', 'useLocal', 'retry']);
    expect(buttons.at(-1)?.classList.contains('ui-button--primary')).toBe(true);
    expect(buttons[0]?.classList.contains('ui-button--secondary')).toBe(true);

    button('Use Local Mode').click();
    button('Manage').click();
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(['useLocal', 'manage']);
  });

  it('lists conflict files', async () => {
    const conflict = createDecisionCardView(
      sessionWorktree('failed', {}, { failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['src/a.ts', 'src/b.ts'] } }),
      t,
    )!;
    mount(CreateDecisionCard, { view: conflict });
    await nextTick();
    expect([...host.querySelectorAll('.wcc-file')].map((item) => item.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('runs the primary action on Enter outside editable fields and blocks actions while busy', async () => {
    const onAction = vi.fn();
    const view = createDecisionCardView(sessionWorktree('failed', {}, { failure: { kind: 'fetch_failed' } }), t)!;
    const state = reactive<{ busy: string | null }>({ busy: null });
    mount(CreateDecisionCard, () => ({ view, busyAction: state.busy, onAction }));
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
    expect([...host.querySelectorAll<HTMLButtonElement>('.abtns button')].every((item) => item.disabled)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('CreateDecisionCard for a missing worktree', () => {
  it('offers recreate and local mode for a missing worktree', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView(sessionWorktree('ready', { path: '/w', branch: 'kimi/1', missing: true }), t)!;
    mount(CreateDecisionCard, { view, onAction });
    await nextTick();

    expect(text('.wcc-text')).toBe(view.body);
    expect(button('Recreate Worktree').classList.contains('ui-button--primary')).toBe(true);
    button('Recreate Worktree').click();
    button('Use Local Mode').click();
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(['recreate', 'useLocal']);
  });

  it('shows the running command with a stop button while recreating', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView(
      sessionWorktree(
        'running',
        { branch: 'kimi/1', missing: true },
        { purpose: 'recreate', steps: [step('prune', 'done'), step('create', 'running', { command: 'git worktree add /w kimi/1' })] },
      ),
      t,
    )!;
    mount(CreateDecisionCard, { view, onAction });
    await nextTick();

    expect(text('.wcc-command')).toBe('git worktree add /w kimi/1');
    expect(host.querySelectorAll('.abtns button')).toHaveLength(1);
    expect(button('Stop').classList.contains('ui-button--primary')).toBe(false);
    button('Stop').click();
    expect(onAction).toHaveBeenCalledWith('stop');
  });

  it('toggles the raw output of a failed recreate without emitting', async () => {
    const onAction = vi.fn();
    const view = createInvalidCardView(
      sessionWorktree(
        'failed',
        { branch: 'kimi/1', missing: true },
        {
          purpose: 'recreate',
          failure: { kind: 'disk_full' },
          steps: [step('create', 'failed', { command: 'git worktree add /w kimi/1', output: 'No space left on device' })],
        },
      ),
      t,
    )!;
    mount(CreateDecisionCard, { view, onAction });
    await nextTick();

    expect(text('.akind')).toBe('Worktree recreation failed');
    expect(host.querySelector('.wcc-output')).toBeNull();
    button('View Raw Output').click();
    await nextTick();
    expect(text('.wcc-output')).toBe('git worktree add /w kimi/1\nNo space left on device');
    expect(onAction).not.toHaveBeenCalled();
    button('Hide Raw Output').click();
    await nextTick();
    expect(host.querySelector('.wcc-output')).toBeNull();
  });
});
