// @vitest-environment jsdom
import { nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionWorktree } from '@moonshot-ai/app-client/testing';
import type { AppSessionWorktree, AppWorktreeSetupStep } from '@moonshot-ai/app-core/api';
import CreateDecisionCard from '../src/worktree/CreateDecisionCard.vue';
import CreateProgressBlock from '../src/worktree/CreateProgressBlock.vue';
import { forgetCreateRuns } from '../src/worktree/createBlockMemory';
import { createDecisionCardView, createInvalidCardView, type CreateTranslate } from '../src/worktree/createPresentation';
import { cleanup, containing, msg, press, render, textOf, within } from './helpers/dom';

const t = msg as CreateTranslate;

function step(kind: AppWorktreeSetupStep['kind'], state: AppWorktreeSetupStep['state'], extra: Partial<AppWorktreeSetupStep> = {}): AppWorktreeSetupStep {
  return { kind, state, ...extra };
}

async function mount(component: Parameters<typeof render>[0], props: Parameters<typeof render>[1]) {
  const { host } = render(component, props);
  await nextTick();
  return within(host);
}

beforeEach(() => {
  forgetCreateRuns();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CreateProgressBlock', () => {
  const expandButton = (view: ReturnType<typeof within>) =>
    view.getByRole('button', { name: msg('worktreeCreate.block.expand') });
  const collapseButton = (view: ReturnType<typeof within>) =>
    view.getByRole('button', { name: msg('worktreeCreate.block.collapse') });
  const stepTexts = (view: ReturnType<typeof within>) => view.queryAllByRole('listitem').map((item) => textOf(item));

  it('opens while creating, counts the running command and shows every step with its command', async () => {
    const worktree = sessionWorktree('running', {}, {
      commandsRan: 1,
      steps: [
        step('fetch', 'done', { ref: 'origin/main', command: 'git fetch --no-tags origin main' }),
        step('create', 'running', { ref: 'origin/main', command: 'git worktree add --no-track -b kimi/1 /w origin/main' }),
        step('changes', 'pending', { command: 'git cherry-pick --no-commit abc' }),
      ],
    });
    const view = await mount(CreateProgressBlock, { worktree, sessionId: 's1' });

    expect(collapseButton(view).getAttribute('aria-expanded')).toBe('true');
    expect(textOf(view.getByRole('status', { name: msg('worktreeCreate.block.creating') }))).toBe(
      msg('worktreeCreate.block.creating'),
    );
    expect(view.getByText(msg('worktreeCreate.block.commandsRan', { n: 2 }, 2))).toBeTruthy();
    const steps = stepTexts(view);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain(msg('worktreeCreate.step.fetch.done', { ref: 'origin/main' }));
    expect(steps[1]).toContain(msg('worktreeCreate.step.create.running', { ref: 'origin/main' }));
    expect(steps[2]).toContain(msg('worktreeCreate.step.changes.pending'));
    expect(steps[2]).toContain('git cherry-pick --no-commit abc');
  });

  it('collapses once created, notes included changes and expands on demand', async () => {
    const worktree = sessionWorktree(
      'ready',
      { path: '/w', includedLocalChanges: true },
      { commandsRan: 2, steps: [step('create', 'done', { ref: 'main', command: 'git worktree add /w main' }), step('changes', 'done')] },
    );
    const view = await mount(CreateProgressBlock, { worktree, sessionId: 's1' });

    expect(view.getByRole('status', { name: msg('worktreeCreate.block.created') })).toBeTruthy();
    expect(view.getByText(msg('worktreeCreate.block.commandsRan', { n: 2 }, 2))).toBeTruthy();
    expect(view.getByText(msg('worktreeCreate.block.includedLocalChanges'))).toBeTruthy();
    expect(expandButton(view).getAttribute('aria-expanded')).toBe('false');
    expect(stepTexts(view)).toEqual([]);

    expandButton(view).click();
    await nextTick();

    expect(collapseButton(view).getAttribute('aria-expanded')).toBe('true');
    expect(stepTexts(view)).toEqual([
      expect.stringContaining(msg('worktreeCreate.step.create.done', { ref: 'main' })),
      msg('worktreeCreate.step.changes.done'),
    ]);
  });

  it('expands by itself when creation fails, even after the user collapsed it, and shows the output', async () => {
    const state = reactive<{ worktree: AppSessionWorktree }>({
      worktree: sessionWorktree('running', {}, { steps: [step('fetch', 'running', { ref: 'origin/main', command: 'git fetch' })] }),
    });
    const view = await mount(CreateProgressBlock, () => ({ worktree: state.worktree, sessionId: 's1' }));
    collapseButton(view).click();
    await nextTick();
    expect(stepTexts(view)).toEqual([]);

    state.worktree = sessionWorktree('failed', {}, {
      failure: { kind: 'fetch_failed' },
      commandsRan: 1,
      steps: [step('fetch', 'failed', { ref: 'origin/main', command: 'git fetch', output: 'fatal: Could not resolve host' })],
    });
    await nextTick();

    expect(view.getByRole('status', { name: msg('worktreeCreate.block.fetchFailed') })).toBeTruthy();
    expect(view.getByText(msg('worktreeCreate.block.commandsRan', { n: 1 }, 1))).toBeTruthy();
    expect(collapseButton(view).getAttribute('aria-expanded')).toBe('true');
    const [failed] = stepTexts(view);
    expect(failed).toContain(msg('worktreeCreate.step.fetch.failed', { ref: 'origin/main' }));
    expect(failed).toContain('fatal: Could not resolve host');
  });

  it('keeps showing the original creation while the worktree is recreated', async () => {
    const state = reactive<{ worktree: AppSessionWorktree }>({
      worktree: sessionWorktree('ready', { path: '/w' }, { commandsRan: 1, steps: [step('create', 'done', { ref: 'main' })] }),
    });
    const view = await mount(CreateProgressBlock, () => ({ worktree: state.worktree, sessionId: 's1' }));

    state.worktree = sessionWorktree(
      'running',
      { branch: 'kimi/1', missing: true },
      { purpose: 'recreate', steps: [step('prune', 'running'), step('create', 'pending')] },
    );
    await nextTick();

    expect(view.getByRole('status', { name: msg('worktreeCreate.block.created') })).toBeTruthy();
    expect(view.getByText(msg('worktreeCreate.block.commandsRan', { n: 1 }, 1))).toBeTruthy();
    expect(expandButton(view).getAttribute('aria-expanded')).toBe('false');
    expect(stepTexts(view)).toEqual([]);
  });
});

describe('CreateDecisionCard', () => {
  const buttonNames = (view: ReturnType<typeof within>) => view.getAllByRole('button').map((item) => textOf(item));

  it('names the card after the problem, explains it and emits the chosen action', async () => {
    const onAction = vi.fn();
    const card = createDecisionCardView(sessionWorktree('failed', {}, { failure: { kind: 'disk_full' } }), t)!;
    const view = await mount(CreateDecisionCard, { view: card, onAction });

    const group = view.getByRole('group', { name: msg('worktreeCreate.card.createFailedTitle') });
    expect(textOf(group)).toContain(msg('worktreeCreate.card.diskFullBody'));
    expect(buttonNames(view)).toEqual([
      msg('worktreeCreate.action.manage'),
      msg('worktreeCreate.action.useLocal'),
      msg('worktreeCreate.action.retry'),
    ]);

    view.getByRole('button', { name: msg('worktreeCreate.action.useLocal') }).click();
    view.getByRole('button', { name: msg('worktreeCreate.action.manage') }).click();
    expect(onAction.mock.calls).toEqual([['useLocal'], ['manage']]);
  });

  it('lists the conflicting files', async () => {
    const conflict = createDecisionCardView(
      sessionWorktree('failed', {}, { failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['src/a.ts', 'src/b.ts'] } }),
      t,
    )!;
    const view = await mount(CreateDecisionCard, { view: conflict });

    expect(view.getAllByRole('listitem').map((item) => textOf(item))).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('runs the primary action on Enter outside editable fields and blocks every action while one is busy', async () => {
    const onAction = vi.fn();
    const card = createDecisionCardView(sessionWorktree('failed', {}, { failure: { kind: 'fetch_failed' } }), t)!;
    const state = reactive<{ busy: string | null }>({ busy: null });
    const view = await mount(CreateDecisionCard, () => ({ view: card, busyAction: state.busy, onAction }));

    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    press(document, 'Enter');
    expect(onAction).not.toHaveBeenCalled();
    input.remove();

    press(document, 'Enter');
    expect(onAction.mock.calls).toEqual([['retry']]);

    state.busy = 'retry';
    await nextTick();
    onAction.mockClear();
    expect(view.getAllByRole('button').every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
    expect(view.getByRole('button', { name: containing(msg('worktreeCreate.action.retry')) }).getAttribute('aria-busy')).toBe('true');
    press(document, 'Enter');
    view.getByRole('button', { name: msg('worktreeCreate.action.createFromLocal', { branch: 'main' }) }).click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('toggles the raw output of a failed recreate without emitting', async () => {
    const onAction = vi.fn();
    const card = createInvalidCardView(
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
    const view = await mount(CreateDecisionCard, { view: card, onAction });
    const group = view.getByRole('group', { name: msg('worktreeCreate.invalid.failedTitle') });
    const show = view.getByRole('button', { name: msg('worktreeCreate.action.viewOutput') });

    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(textOf(group)).not.toContain('No space left on device');

    show.click();
    await nextTick();
    const hide = view.getByRole('button', { name: msg('worktreeCreate.action.hideOutput') });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(textOf(group)).toContain('git worktree add /w kimi/1 No space left on device');

    hide.click();
    await nextTick();
    expect(textOf(group)).not.toContain('No space left on device');
    expect(onAction).not.toHaveBeenCalled();
  });
});
