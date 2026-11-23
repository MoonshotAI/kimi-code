import { stripVTControlCharacters } from 'node:util';

import type { KimiWorktree } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorktreeDeletePrompt, type WorktreeRemoval } from '#/tui/components/dialogs/worktree-choices';
import { WorktreeFormComponent } from '#/tui/components/dialogs/worktree-form';
import { WorktreePanelComponent, type WorktreePanelRow } from '#/tui/components/dialogs/worktree-panel';

const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const DOWN = '\u001B[B';

const ROOT = '/home/me/.kimi-code/worktrees/wd_repo';
const APC = /\u001B_[^\u0007]*\u0007/g;

function worktree(name: string, overrides: Partial<KimiWorktree> = {}): KimiWorktree {
  return { path: `${ROOT}/${name}`, name, head: 'abc1234', branch: undefined, missing: false, ...overrides };
}

function rows(current: 'source' | string = 'source'): WorktreePanelRow[] {
  return [
    { kind: 'source', path: '/home/me/code/repo', current: current === 'source' },
    { kind: 'worktree', worktree: worktree('fix-login'), current: current === 'fix-login' },
    { kind: 'worktree', worktree: worktree('gone', { missing: true }), current: false },
    { kind: 'new' },
  ];
}

function makePanel(current?: string) {
  const handlers = { onOpen: vi.fn(), onNew: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn() };
  const panel = new WorktreePanelComponent({ repoName: 'repo', rows: rows(current), ...handlers });
  panel.focused = true;
  const text = (): string => stripVTControlCharacters(panel.render(100).join('\n'));
  return { panel, handlers, text };
}

function removal(overrides: Partial<WorktreeRemoval> = {}): WorktreeRemoval {
  return {
    repoRoot: '/home/me/code/repo',
    path: `${ROOT}/fix-login`,
    name: 'fix-login',
    branch: undefined,
    uncommittedFiles: 0,
    commitsLostWithWorktree: 0,
    commitsLostWithBranch: 0,
    openSessionIds: [],
    closedSessionCount: 0,
    ...overrides,
  };
}

function promptText(input: WorktreeRemoval): string {
  const prompt = createWorktreeDeletePrompt({ removal: input, onChoose: vi.fn() });
  return stripVTControlCharacters(prompt.render(100).join('\n'));
}

beforeEach(() => {
  vi.stubEnv('HOME', '/home/me');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('WorktreePanelComponent', () => {
  it('lists the source first, then the worktrees, then the new row', () => {
    const { text } = makePanel();
    const lines = text().split('\n');

    expect(lines[1]).toBe(' Worktrees  repo');
    expect(lines[2]).toBe(' ↑↓ navigate · Enter open · N new · D delete · Esc cancel');
    const body = lines.filter((line) => line.startsWith('  ')).map((line) => line.trimEnd());
    expect(body).toEqual([
      '  ❯ ~/code/repo                               source ← current',
      '    ~/.kimi-code/worktrees/wd_repo/fix-login',
      '    ~/.kimi-code/worktrees/wd_repo/gone       missing',
      '    + New worktree',
    ]);
  });

  it('starts on the current worktree and closes when it is entered', () => {
    const { panel, handlers, text } = makePanel('fix-login');
    expect(text()).toContain('❯ ~/.kimi-code/worktrees/wd_repo/fix-login');
    expect(text()).toMatch(/fix-login\s+← current/);

    panel.handleInput(ENTER);

    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('opens another checkout on Enter', () => {
    const { panel, handlers } = makePanel();
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);

    expect(handlers.onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'worktree', worktree: worktree('fix-login') }));
  });

  it('explains a missing worktree instead of opening it', () => {
    const { panel, handlers, text } = makePanel();
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);

    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(text().split('\n')[3]).toBe(" This worktree's directory is missing. Delete it to clean up the git record.");

    panel.handleInput(DOWN);
    expect(text()).not.toContain('directory is missing');
  });

  it('opens the form from N, n, and the new row', () => {
    const { panel, handlers } = makePanel();
    panel.handleInput('N');
    panel.handleInput('n');
    for (let i = 0; i < 3; i += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);

    expect(handlers.onNew).toHaveBeenCalledTimes(3);
  });

  it('refuses to delete the source checkout or the current worktree', () => {
    const source = makePanel();
    source.panel.handleInput('d');
    expect(source.text()).toContain(" You can't delete the source checkout.");

    const current = makePanel('fix-login');
    current.panel.handleInput('D');
    expect(current.text()).toContain(" You're in this worktree. Leave it first, or exit Kimi Code to clean it up.");

    expect(source.handlers.onDelete).not.toHaveBeenCalled();
    expect(current.handlers.onDelete).not.toHaveBeenCalled();
  });

  it('deletes another worktree, missing or not, with D', () => {
    const { panel, handlers } = makePanel();
    panel.handleInput(DOWN);
    panel.handleInput('D');
    panel.handleInput(DOWN);
    panel.handleInput('d');

    expect(handlers.onDelete.mock.calls.map(([row]) => (row as { worktree: KimiWorktree }).worktree.name)).toEqual([
      'fix-login',
      'gone',
    ]);
  });

  it('shows a notice under the hint and closes on Esc', () => {
    const { panel, handlers, text } = makePanel();
    panel.setNotice({ text: 'Deleted gone.', tone: 'success' });
    expect(text().split('\n')[3]).toBe(' Deleted gone.');

    panel.handleInput(ESC);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('pages long lists', () => {
    const many: WorktreePanelRow[] = [
      { kind: 'source', path: '/home/me/code/repo', current: true },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: 'worktree' as const, worktree: worktree(`wt-${String(i)}`), current: false })),
      { kind: 'new' },
    ];
    const panel = new WorktreePanelComponent({
      repoName: 'repo',
      rows: many,
      pageSize: 8,
      onOpen: vi.fn(),
      onNew: vi.fn(),
      onDelete: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(stripVTControlCharacters(panel.render(100).join('\n'))).toContain(' ▼ 6 more');
  });
});

describe('WorktreeFormComponent', () => {
  function makeForm() {
    const handlers = { onSubmit: vi.fn(), onCancel: vi.fn() };
    const form = new WorktreeFormComponent(handlers);
    form.focused = true;
    const text = (): string => stripVTControlCharacters(form.render(90).join('\n').replaceAll(APC, ''));
    const type = (value: string): void => {
      for (const char of value) form.handleInput(char);
    };
    return { form, handlers, text, type };
  }

  it('shows both fields with their placeholders and the help line', () => {
    const { text } = makeForm();
    const lines = text().split('\n');

    expect(lines[0]).toMatch(/^╭─ New worktree ─+╮$/);
    expect(lines[1]).toMatch(/^│ Name {2}generated\s+│$/);
    expect(lines[2]).toMatch(/^│ Base {2}HEAD\s+│$/);
    expect(lines[3]).toMatch(/^╰─+╯$/);
    expect(lines[4]).toBe(' Tab next field · Enter create · Esc cancel');
    expect(lines[5]).toBe(' Leave Name empty for a generated name. Base takes a branch, tag, or commit.');
  });

  it('submits trimmed values from any field and leaves empty fields to the engine', () => {
    const { form, handlers, type } = makeForm();
    type(' fix-login ');
    form.handleInput(TAB);
    form.handleInput(ENTER);
    type('v1.2');
    form.handleInput(ENTER);

    expect(handlers.onSubmit.mock.calls).toEqual([
      [{ name: 'fix-login', base: undefined }],
      [{ name: 'fix-login', base: 'v1.2' }],
    ]);
  });

  it('shows the engine error, returns to the field at fault, and clears the error on typing', () => {
    const { form, text, type } = makeForm();
    form.showError('"v9" is not a commit, branch or tag in this repository.', 'base');

    expect(text().split('\n')[5]).toBe(' "v9" is not a commit, branch or tag in this repository.');
    type('x');
    expect(text()).toMatch(/│ Base {2}x\s+│/);
    expect(text()).toContain('Leave Name empty for a generated name.');
  });

  it('cancels on Esc', () => {
    const { form, handlers } = makeForm();
    form.handleInput(ESC);

    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });
});

describe('createWorktreeDeletePrompt', () => {
  it('names every loss and what each delete option discards', () => {
    const text = promptText(removal({ uncommittedFiles: 3, commitsLostWithWorktree: 2, closedSessionCount: 1 }));

    expect(text).toContain(' Delete worktree fix-login?');
    expect(text).toContain('~/.kimi-code/worktrees/wd_repo/fix-login');
    expect(text).toContain('3 uncommitted files will be lost.');
    expect(text).toContain('2 commits exist only in this worktree.');
    expect(text).toContain('1 earlier session worked here. You can still read it, but not continue it.');
    expect(text).toMatch(/Keep it\n/);
    expect(text).toMatch(/Delete worktree\s+Discards 3 files and 2 commits/);
    expect(text).not.toContain('and branch');
  });

  it('shows only the path when nothing would be lost', () => {
    const text = promptText(removal({ closedSessionCount: 0 }));

    expect(text).not.toContain('will be lost');
    expect(text).not.toContain('exist only');
    expect(text).not.toContain('earlier session');
    expect(text).not.toContain('Discards');
  });

  it('offers to delete the branch, counting the commits only it holds', () => {
    const text = promptText(removal({ branch: 'feat-login', commitsLostWithBranch: 1, closedSessionCount: 2 }));

    expect(text).toContain('1 commit exists only on branch feat-login.');
    expect(text).toContain('2 earlier sessions worked here. You can still read them, but not continue them.');
    expect(text).toMatch(/Delete worktree and branch feat-login\s+Discards 1 commit/);
    expect(text).not.toMatch(/Delete worktree\s+Discards/);
  });

  it('chooses with the arrow keys and keeps the worktree on Esc', () => {
    const onChoose = vi.fn();
    const prompt = createWorktreeDeletePrompt({ removal: removal({ branch: 'feat-login' }), onChoose });
    prompt.handleInput(DOWN);
    prompt.handleInput(DOWN);
    prompt.handleInput(ENTER);
    prompt.handleInput(ESC);

    expect(onChoose.mock.calls).toEqual([['delete-branch'], ['keep']]);
  });
});
