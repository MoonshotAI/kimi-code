import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { worktreeSetup } from '@moonshot-ai/app-client/testing';
import { messages } from '@moonshot-ai/app-i18n';
import type {
  AppSessionWorktree,
  AppWorktreeSetup,
  AppWorktreeSetupStep,
  AppWorktreeSetupStepKind,
  AppWorktreeSetupStepState,
} from '@moonshot-ai/app-core/api';
import {
  createBlockView,
  createDecisionCardView,
  createInvalidCardView,
  createStepLabel,
  type CreateCardView,
  type CreateTranslate,
} from '../src/worktree/createPresentation';

const requestedKeys = new Set<string>();

const t: CreateTranslate = (key, named) => {
  requestedKeys.add(key);
  if (named === undefined) return key;
  return `${key}(${Object.entries(named)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(',')})`;
};

function worktree(overrides: Partial<AppWorktreeSetup> = {}, extra: Partial<AppSessionWorktree> = {}): AppSessionWorktree {
  return { ...extra, setup: worktreeSetup(overrides) };
}

function step(kind: AppWorktreeSetupStepKind, state: AppWorktreeSetupStepState, extra: Partial<AppWorktreeSetupStep> = {}): AppWorktreeSetupStep {
  return { kind, state, ...extra };
}

function decision(view: CreateCardView | null) {
  if (view === null) return null;
  return {
    title: view.title,
    body: view.body,
    actions: view.actions.map((item) => item.id),
    primary: view.actions.filter((item) => item.primary === true).map((item) => item.id),
  };
}

describe('worktree creation step label', () => {
  const ref = 'origin/main';

  it.each<[AppWorktreeSetupStep, string]>([
    [step('fetch', 'pending', { ref }), 'worktreeCreate.step.fetch.pending(ref=origin/main)'],
    [step('fetch', 'failed', { ref }), 'worktreeCreate.step.fetch.failed(ref=origin/main)'],
    [step('fetch', 'failed', { ref, timedOut: true }), 'worktreeCreate.step.fetch.timedOut(ref=origin/main)'],
    [step('fetch', 'running'), 'worktreeCreate.step.fetchPlain.running'],
    [step('create', 'pending'), 'worktreeCreate.step.createPlain.pending'],
    [step('create', 'running', { ref: '' }), 'worktreeCreate.step.createPlain.running'],
    [step('create', 'done', { ref: 'main' }), 'worktreeCreate.step.create.done(ref=main)'],
    [step('changes', 'failed', { timedOut: true }), 'worktreeCreate.step.changes.timedOut'],
    [step('prune', 'running', { ref }), 'worktreeCreate.step.prune.running'],
  ])('labels %j with %s', (item, key) => {
    expect(createStepLabel(item, t)).toBe(key);
  });
});

describe('worktree creation block', () => {
  it.each<[Partial<AppWorktreeSetup>, string]>([
    [{ status: 'running' }, 'creating'],
    [{ status: 'ready' }, 'created'],
    [{ status: 'failed', failure: { kind: 'fetch_failed' } }, 'fetchFailed'],
    [{ status: 'failed', failure: { kind: 'fetch_timeout' } }, 'fetchTimeout'],
    [{ status: 'failed', failure: { kind: 'conflict' } }, 'conflict'],
    [{ status: 'failed', failure: { kind: 'disk_full' } }, 'createFailed'],
    [{ status: 'failed', failure: { kind: 'create_failed' } }, 'createFailed'],
    [{ status: 'stopped', stoppedStep: 'create' }, 'stopped'],
    [{ status: 'local' }, 'local'],
  ])('titles %j as block.%s', (overrides, title) => {
    expect(createBlockView(worktree(overrides), t).title).toBe(`worktreeCreate.block.${title}`);
  });

  it('counts the running command and connects each step to a reached successor', () => {
    const view = createBlockView(
      worktree({
        status: 'running',
        commandsRan: 1,
        steps: [
          step('fetch', 'done', { ref: 'origin/main', command: 'git fetch' }),
          step('create', 'running', { ref: 'origin/main', command: 'git worktree add' }),
          step('changes', 'pending', { command: 'git cherry-pick', output: '  ' }),
        ],
      }),
      t,
    );

    expect(view.meta).toBe('worktreeCreate.block.commandsRan(n=2)');
    expect(view.steps.map((item) => [item.tone, item.connected])).toEqual([
      ['done', true],
      ['running', false],
      ['pending', false],
    ]);
    expect(view.steps[2]).toMatchObject({ command: 'git cherry-pick' });
    expect(view.steps[2]).not.toHaveProperty('output');
    expect(view).toMatchObject({ expandable: true, defaultOpen: true, note: null });
  });

  it.each<[Partial<AppWorktreeSetup>, boolean]>([
    [{ status: 'running', steps: [step('fetch', 'running')] }, true],
    [{ status: 'failed', steps: [step('fetch', 'failed')] }, true],
    [{ status: 'ready', steps: [step('create', 'done')] }, false],
    [{ status: 'stopped', steps: [step('create', 'stopped')] }, false],
  ])('opens %j by default: %s', (overrides, open) => {
    expect(createBlockView(worktree(overrides), t).defaultOpen).toBe(open);
  });

  it('omits the command count before any command and notes included local changes', () => {
    const view = createBlockView(worktree({ status: 'ready', commandsRan: 0 }, { includedLocalChanges: true }), t);

    expect(view).toMatchObject({ meta: null, note: 'worktreeCreate.block.includedLocalChanges', expandable: false });
  });

  it('keeps the trimmed output of a failed step', () => {
    const view = createBlockView(
      worktree({ status: 'failed', steps: [step('fetch', 'failed', { output: 'fatal: host\n\n' })] }),
      t,
    );

    expect(view.steps[0]?.output).toBe('fatal: host');
  });

  it('shows the original creation while a recreate run is in progress', () => {
    const original = worktree({ status: 'ready', commandsRan: 1, steps: [step('create', 'done', { ref: 'main' })] }, { path: '/w' });
    const recreating = worktree({ purpose: 'recreate', status: 'running', steps: [step('prune', 'running'), step('create', 'pending')] });

    expect(createBlockView(recreating, t, original)).toEqual(createBlockView(original, t));
  });

  it.each<[string, Partial<AppWorktreeSetup>, AppSessionWorktree | null, string]>([
    ['running without the original', { status: 'running', steps: [step('prune', 'running')] }, null, 'created'],
    ['failed without the original', { status: 'failed', failure: { kind: 'create_failed' } }, null, 'created'],
    ['switched to local mode', { status: 'local' }, worktree({ status: 'ready' }, { path: '/w' }), 'local'],
  ])('falls back to a static block for a recreate run %s', (_label, overrides, original, title) => {
    expect(createBlockView(worktree({ purpose: 'recreate', ...overrides }), t, original)).toEqual({
      title: `worktreeCreate.block.${title}`,
      meta: null,
      note: null,
      steps: [],
      expandable: false,
      defaultOpen: false,
    });
  });
});

describe('worktree decision card', () => {
  it.each<[string, Partial<AppWorktreeSetup>, ReturnType<typeof decision>]>([
    [
      'fetch failure',
      { status: 'failed', failure: { kind: 'fetch_failed' } },
      {
        title: 'worktreeCreate.card.fetchFailedTitle',
        body: 'worktreeCreate.card.fetchFailedBody',
        actions: ['createFromLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'fetch timeout',
      { status: 'failed', failure: { kind: 'fetch_timeout' } },
      {
        title: 'worktreeCreate.card.fetchTimeoutTitle',
        body: 'worktreeCreate.card.fetchTimeoutBody(seconds=30)',
        actions: ['createFromLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'full disk',
      { status: 'failed', failure: { kind: 'disk_full' } },
      {
        title: 'worktreeCreate.card.createFailedTitle',
        body: 'worktreeCreate.card.diskFullBody',
        actions: ['manage', 'useLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'creation failure',
      { status: 'failed', failure: { kind: 'create_failed' } },
      {
        title: 'worktreeCreate.card.createFailedTitle',
        body: 'worktreeCreate.card.createFailedBody',
        actions: ['useLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'failure without details',
      { status: 'failed' },
      {
        title: 'worktreeCreate.card.createFailedTitle',
        body: 'worktreeCreate.card.createFailedBody',
        actions: ['useLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'stop during creation',
      { status: 'stopped', stoppedStep: 'create' },
      {
        title: 'worktreeCreate.card.stoppedTitle',
        body: 'worktreeCreate.card.stoppedBody',
        actions: ['useLocal', 'retry'],
        primary: ['retry'],
      },
    ],
    [
      'stop during the fetch',
      { status: 'stopped', stoppedStep: 'fetch' },
      {
        title: 'worktreeCreate.card.stoppedTitle',
        body: 'worktreeCreate.card.stoppedBody',
        actions: ['createFromLocal', 'retry'],
        primary: ['retry'],
      },
    ],
  ])('offers the right choices after a %s', (_label, overrides, expected) => {
    expect(decision(createDecisionCardView(worktree(overrides), t))).toEqual(expected);
  });

  it('names the source branch in the local creation choice', () => {
    const view = createDecisionCardView(
      worktree({ status: 'failed', request: { sourceBranch: 'feature/login' }, failure: { kind: 'fetch_failed' } }),
      t,
    );

    expect(view?.actions[0]?.label).toBe('worktreeCreate.action.createFromLocal(branch=feature/login)');
  });

  it('lists conflicting files and makes local creation the primary choice', () => {
    const view = createDecisionCardView(
      worktree({
        status: 'failed',
        request: { sourceBranch: 'main', includeLocalChanges: true, useRemote: true },
        failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['src/greet.js'] },
      }),
      t,
    );

    expect(view?.kind).toBe('conflict');
    expect(view?.files).toEqual(['src/greet.js']);
    expect(decision(view)).toEqual({
      title: 'worktreeCreate.card.conflictTitle',
      body: 'worktreeCreate.card.conflictBody(ref=origin/main)',
      actions: ['createFromRemote', 'createFromLocal'],
      primary: ['createFromLocal'],
    });
  });

  it.each<[string, AppSessionWorktree | null]>([
    ['no worktree', null],
    ['a running creation', worktree({ status: 'running' })],
    ['a missing worktree', worktree({ status: 'ready' }, { path: '/w', missing: true })],
    ['a failed recreate run', worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'create_failed' } })],
  ])('shows no decision card for %s', (_label, value) => {
    expect(createDecisionCardView(value, t)).toBeNull();
  });
});

describe('invalid worktree card', () => {
  const missing = { path: '/w', branch: 'kimi/1111-3321', missing: true };

  it('offers recreate as the primary choice while the branch exists', () => {
    const view = createInvalidCardView(worktree({ status: 'ready' }, missing), t);

    expect(view?.phase).toBe('missing');
    expect(decision(view)).toEqual({
      title: 'worktreeCreate.invalid.missingTitle',
      body: 'worktreeCreate.invalid.missingBody(branch=kimi/1111-3321)',
      actions: ['useLocal', 'recreate'],
      primary: ['recreate'],
    });
  });

  it('only offers local mode when the branch is gone', () => {
    const view = createInvalidCardView(worktree({ status: 'ready' }, { ...missing, branchMissing: true }), t);

    expect(view?.phase).toBe('branchGone');
    expect(decision(view)).toEqual({
      title: 'worktreeCreate.invalid.missingTitle',
      body: 'worktreeCreate.invalid.branchGoneBody(branch=kimi/1111-3321)',
      actions: ['useLocal'],
      primary: ['useLocal'],
    });
  });

  it('follows the recreate run from cleanup to creation with only a Stop action', () => {
    const run = (steps: AppWorktreeSetupStep[]) =>
      createInvalidCardView(
        worktree({ purpose: 'recreate', status: 'running', steps }, { branch: 'kimi/1111-3321', missing: true }),
        t,
      );

    const cleaning = run([step('prune', 'running', { command: 'git worktree prune' }), step('create', 'pending')]);
    expect(cleaning).toMatchObject({ phase: 'recreating', title: 'worktreeCreate.invalid.cleaningTitle', command: 'git worktree prune' });
    expect(decision(cleaning)).toMatchObject({ actions: ['stop'], primary: [] });

    const creating = run([step('prune', 'done'), step('create', 'running', { command: 'git worktree add /w kimi/1111-3321' })]);
    expect(creating).toMatchObject({
      phase: 'recreating',
      title: 'worktreeCreate.invalid.recreatingTitle(branch=kimi/1111-3321)',
      command: 'git worktree add /w kimi/1111-3321',
    });
  });

  it.each<[string, AppWorktreeSetup['failure'], string, string[]]>([
    ['a creation error', { kind: 'create_failed' }, 'worktreeCreate.invalid.failedBody', ['viewOutput', 'useLocal', 'retry']],
    ['a full disk', { kind: 'disk_full' }, 'worktreeCreate.invalid.diskFullBody', ['viewOutput', 'manage', 'useLocal', 'retry']],
  ])('reports a recreate that failed with %s and keeps its raw output', (_label, failure, body, actions) => {
    const steps = [step('prune', 'done'), step('create', 'failed', { command: 'git worktree add /w b', output: 'fatal: boom\n' })];
    const view = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'failed', stoppedStep: 'create', failure, steps }, { branch: 'b', missing: true }),
      t,
    );

    expect(view).toMatchObject({ phase: 'failed', title: 'worktreeCreate.invalid.failedTitle', output: 'git worktree add /w b\nfatal: boom' });
    expect(decision(view)).toMatchObject({ body, actions, primary: ['retry'] });
  });

  it('offers no raw output when the failed recreate printed nothing', () => {
    const view = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'create_failed' } }, { branch: 'b', missing: true }),
      t,
    );

    expect(view?.output).toBeNull();
    expect(decision(view)?.actions).toEqual(['useLocal', 'retry']);
  });

  it('reports a stopped recreate', () => {
    const view = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'stopped', stoppedStep: 'create' }, { branch: 'b', missing: true }),
      t,
    );

    expect(view?.phase).toBe('stopped');
    expect(decision(view)).toEqual({
      title: 'worktreeCreate.invalid.stoppedTitle',
      body: 'worktreeCreate.invalid.stoppedBody',
      actions: ['useLocal', 'retry'],
      primary: ['retry'],
    });
  });

  it.each<[string, AppSessionWorktree]>([
    ['a finished recreate', worktree({ purpose: 'recreate', status: 'ready' }, { path: '/w', branch: 'b' })],
    ['a healthy worktree', worktree({ status: 'ready' }, { path: '/w' })],
  ])('shows no invalid card for %s', (_label, value) => {
    expect(createInvalidCardView(value, t)).toBeNull();
  });
});

type Messages = { [key: string]: string | Messages };

function resolves(locale: Messages, key: string): boolean {
  let node: string | Messages | undefined = locale;
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' && node.length > 0;
}

function unresolved(keys: Iterable<string>): string[] {
  const locales = messages as unknown as Record<'en' | 'zh', Messages>;
  return [...keys].flatMap((key) =>
    (['en', 'zh'] as const).filter((locale) => !resolves(locales[locale], key)).map((locale) => `${locale}: ${key}`),
  );
}

function sourceKeys(): Set<string> {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = [
    ...readdirSync(`${root}worktree`)
      .filter((name) => /\.(?:vue|ts)$/.test(name))
      .map((name) => `${root}worktree/${name}`),
    `${root}settings/WorktreesPanel.vue`,
  ];
  const namespaces = Object.keys(messages.en).join('|');
  const pattern = new RegExp(`['"\`]((?:${namespaces})\\.[\\w.]+)['"\`]`, 'g');
  const keys = new Set<string>();
  for (const file of files) for (const [, key] of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(key!);
  return keys;
}

describe('worktree component copy', () => {
  it('resolves every step label in English and Chinese', () => {
    const kinds: AppWorktreeSetupStepKind[] = ['fetch', 'prune', 'create', 'changes', 'include'];
    const states: AppWorktreeSetupStepState[] = ['pending', 'running', 'done', 'failed', 'stopped', 'skipped'];
    const keys = new Set<string>();
    const record: CreateTranslate = (key) => {
      keys.add(key);
      return key;
    };
    for (const kind of kinds) {
      for (const state of states) {
        for (const ref of [undefined, 'origin/main']) {
          createStepLabel(step(kind, state, { ref }), record);
          createStepLabel(step(kind, state, { ref, timedOut: true }), record);
        }
      }
    }

    expect(unresolved(keys)).toEqual([]);
  });

  it('resolves every key the view models requested and the components name', () => {
    const keys = new Set([...requestedKeys, ...sourceKeys()]);

    expect(keys.size).toBeGreaterThan(50);
    expect(unresolved(keys)).toEqual([]);
  });
});
