import { stripVTControlCharacters } from 'node:util';

import type { KimiWorktree } from '@moonshot-ai/kimi-code-sdk';
import { TuiAltScreen, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

import {
  createLeaveWorktreePrompt,
  createWorktreeDeletePrompt,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';
import { WorktreeFormComponent } from '#/tui/components/dialogs/worktree-form';
import {
  suggestWorktreeName,
  WorktreePanelComponent,
  type WorktreePanelRow,
} from '#/tui/components/dialogs/worktree-panel';

const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const DOWN = '\u001B[B';
const CTRL_N = '\u000E';
const CTRL_X = '\u0018';
const BACKSPACE = '\u007F';

const ROOT = '/home/me/.kimi-code/worktrees/wd_repo';
const APC = /\u001B_[^\u0007]*\u0007/g;

function mouse(overrides: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, 'type' | 'x' | 'y'>): TuiMouseEvent {
  return {
    button: 'none',
    shift: false,
    alt: false,
    ctrl: false,
    screenX: overrides.x,
    screenY: overrides.y,
    width: 100,
    height: 20,
    ...overrides,
  };
}

function worktree(name: string, overrides: Partial<KimiWorktree> = {}): KimiWorktree {
  return {
    path: `${ROOT}/${name}`,
    name,
    head: 'abc1234567890',
    branch: undefined,
    missing: false,
    managed: true,
    ...overrides,
  };
}

function rows(current: 'source' | string = 'source'): WorktreePanelRow[] {
  return [
    {
      kind: 'source',
      path: '/home/me/code/repo',
      branch: 'main',
      head: '11111112222222',
      current: current === 'source',
    },
    { kind: 'worktree', worktree: worktree('fix-login'), current: current === 'fix-login' },
    {
      kind: 'worktree',
      worktree: worktree('feat-ui', { branch: 'feat/ui' }),
      current: current === 'feat-ui',
    },
    { kind: 'worktree', worktree: worktree('gone', { missing: true }), current: false },
  ];
}

function makePanel(
  current?: string,
  options: { readonly layout?: { readonly maxBodyRows: number }; readonly rows?: WorktreePanelRow[] } = {},
) {
  const handlers = { onOpen: vi.fn(), onNew: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn() };
  const panel = new WorktreePanelComponent({
    repoName: 'repo',
    rows: options.rows ?? rows(current),
    layout: options.layout,
    ...handlers,
  });
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
  vi.useRealTimers();
});

describe('suggestWorktreeName', () => {
  it('normalizes branch-style queries into valid worktree directory names', () => {
    expect(suggestWorktreeName('feat/haha')).toBe('feat-haha');
    expect(suggestWorktreeName('  Feat / My Task!  ')).toBe('feat-my-task');
    expect(suggestWorktreeName('..a..b..')).toBe('a-b');
    expect(suggestWorktreeName('v1.2_beta')).toBe('v1.2_beta');
    expect(suggestWorktreeName('')).toBeUndefined();
    expect(suggestWorktreeName('中文')).toBeUndefined();
    expect(suggestWorktreeName('CON')).toBeUndefined();
    expect(suggestWorktreeName('nul.txt')).toBeUndefined();
    expect(suggestWorktreeName(`${'a'.repeat(63)}/b`)).toBe('a'.repeat(63));
  });
});

describe('WorktreePanelComponent', () => {
  it('renders a two-column checkout list with a selected-path footer and no + New row', () => {
    const { text } = makePanel();
    const lines = text().split('\n');

    expect(lines[1]).toBe(' Worktrees  repo  (type to search)');
    expect(lines[2]).toBe(' ↑↓ navigate · Enter open · Ctrl+N new · Ctrl+X delete · Esc cancel');
    const body = lines.filter((line) => line.startsWith('  ')).map((line) => line.trimEnd());
    expect(body).toEqual([
      '  ❯ repo       main ← current',
      '    fix-login  detached abc1234',
      '    feat-ui    feat/ui',
      '    gone       missing',
    ]);
    expect(lines.at(-2)?.trimEnd()).toBe(' ~/code/repo');
    expect(text()).not.toContain('+ New worktree');
  });

  it('renders detached main checkout head and omits the side tag when branch and head are absent', () => {
    const detached = makePanel('source', {
      rows: [{ kind: 'source', path: '/home/me/code/repo', head: '48cdb62abcdef', current: true }],
    });
    expect(detached.text().split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trimEnd())).toEqual([
      '  ❯ repo      detached 48cdb62 ← current',
    ]);

    const empty = makePanel('source', {
      rows: [{ kind: 'source', path: '/home/me/code/repo', current: true }],
    });
    expect(empty.text().split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trimEnd())).toEqual([
      '  ❯ repo      ← current',
    ]);
  });

  it('starts on the current worktree, shows its path in the footer, and closes on Enter', () => {
    const { panel, handlers, text } = makePanel('fix-login');
    expect(text()).toMatch(/❯ fix-login\s+detached abc1234 ← current/);
    expect(text().split('\n').at(-2)?.trimEnd()).toBe(' ~/.kimi-code/worktrees/wd_repo/fix-login');

    panel.handleInput(ENTER);

    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('opens another checkout on Enter and updates the footer path as selection moves', () => {
    const { panel, handlers, text } = makePanel();
    panel.handleInput(DOWN);
    expect(text().split('\n').at(-2)?.trimEnd()).toBe(' ~/.kimi-code/worktrees/wd_repo/fix-login');
    panel.handleInput(ENTER);

    expect(handlers.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'worktree', worktree: worktree('fix-login') }),
    );
  });

  it('explains a missing worktree instead of opening it', () => {
    const { panel, handlers, text } = makePanel();
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);

    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(text().split('\n')[3]).toBe(
      " This worktree's directory is missing. Press Ctrl+X to remove the git record.",
    );

    panel.handleInput('\u001B[A');
    expect(text()).not.toContain('directory is missing');
  });

  it('opens the form from Ctrl+N and prefills a normalized name from an empty search query', () => {
    const { panel, handlers, text } = makePanel();
    panel.handleInput(CTRL_N);
    expect(handlers.onNew).toHaveBeenLastCalledWith(undefined);

    for (const ch of 'feat/haha') panel.handleInput(ch);
    expect(text()).toContain('No matches');
    expect(text()).toContain('❯ + Create "feat-haha"  from HEAD');
    expect(text()).toContain('0 / 4');

    panel.handleInput(ENTER);
    expect(handlers.onNew).toHaveBeenLastCalledWith('feat-haha');

    panel.handleInput(CTRL_N);
    expect(handlers.onNew).toHaveBeenLastCalledWith('feat-haha');

    panel.handleInput(ESC);
    for (const ch of '@@@') panel.handleInput(ch);
    expect(text()).toContain('❯ + Create new worktree  from HEAD');
    panel.handleInput(ENTER);
    expect(handlers.onNew).toHaveBeenLastCalledWith(undefined);
  });

  it('refuses to delete the source checkout or the current worktree', () => {
    const source = makePanel();
    source.panel.handleInput(CTRL_X);
    expect(source.text()).toContain(" You can't delete the source checkout.");

    const current = makePanel('fix-login');
    current.panel.handleInput(CTRL_X);
    expect(current.text()).toContain(
      " You're in this worktree. Leave it first, or exit Kimi Code to clean it up.",
    );

    const externalCurrent = makePanel('external', {
      rows: [
        {
          kind: 'worktree',
          worktree: worktree('external', { path: '/home/me/.herdr/worktrees/repo/external', managed: false }),
          current: true,
        },
        { kind: 'source', path: '/home/me/code/repo', current: false },
      ],
    });
    externalCurrent.panel.handleInput(CTRL_X);
    expect(externalCurrent.text()).toContain(
      " You're in this worktree. Switch to another checkout first.",
    );

    expect(source.handlers.onDelete).not.toHaveBeenCalled();
    expect(current.handlers.onDelete).not.toHaveBeenCalled();
    expect(externalCurrent.handlers.onDelete).not.toHaveBeenCalled();
  });

  it('deletes another worktree, missing or not, with Ctrl+X', () => {
    const { panel, handlers } = makePanel();
    panel.handleInput(DOWN);
    panel.handleInput(CTRL_X);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(CTRL_X);

    expect(
      handlers.onDelete.mock.calls.map(([row]) => (row as { worktree: KimiWorktree }).worktree.name),
    ).toEqual(['fix-login', 'gone']);
  });

  it('filters worktrees by typing, shows match count, and clears on Backspace or first Esc', () => {
    const { panel, handlers, text } = makePanel();
    for (const ch of 'feat/ui') panel.handleInput(ch);

    expect(text()).toContain(' Search: feat/ui');
    expect(text()).toContain('Backspace clear · ↑↓ navigate');
    expect(text()).toContain('feat-ui');
    expect(text()).toContain('1 / 4');
    expect(text()).not.toContain('fix-login');

    panel.handleInput(ENTER);
    expect(handlers.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'worktree', worktree: worktree('feat-ui', { branch: 'feat/ui' }) }),
    );

    panel.handleInput(BACKSPACE);
    expect(text()).toContain(' Search: feat/u');
    panel.handleInput(ESC);
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(text()).not.toContain(' Search:');
    expect(text()).toContain('fix-login');

    for (const ch of 'main') panel.handleInput(ch);
    expect(text()).toContain('1 / 4');
    expect(text()).toContain('main ← current');
    panel.handleInput(ESC);

    for (const ch of 'zzzz-none') panel.handleInput(ch);
    expect(text()).toContain('No matches');
    panel.handleInput(ESC);
    panel.handleInput(ESC);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a notice under the hint and closes on Esc', () => {
    const { panel, handlers, text } = makePanel();
    panel.setNotice({ text: 'Deleted gone.', tone: 'success' });
    expect(text().split('\n')[3]).toBe(' Deleted gone.');

    panel.handleInput(ESC);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('pages large lists with a footer range counter without scanning every row', () => {
    const many: WorktreePanelRow[] = [
      { kind: 'source', path: '/home/me/code/repo', current: true },
      ...Array.from({ length: 500 }, (_, i) => ({
        kind: 'worktree' as const,
        worktree: worktree(`wt-${String(i)}`),
        current: false,
      })),
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

    const rendered = stripVTControlCharacters(panel.render(100).join('\n'));
    expect(rendered).toContain('~/code/repo');
    expect(rendered).toContain('1–8 / 501');
  });

  it('supports fullscreen ScrollView mouse move, click, and wheel scrolling', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { panel, handlers } = makePanel('source', { layout: { maxBodyRows: 3 } });
    const vt = new VirtualTerminal(100, 14);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(panel);
    ui.start();
    ui.setFocus(panel);
    await vt.waitForRender();
    try {
      let screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      const fixLoginRow = screen.findIndex((line) => line.includes('fix-login'));
      expect(fixLoginRow).toBeGreaterThan(0);

      now += 500;
      vt.sendInput(`\u001B[<35;8;${String(fixLoginRow + 1)}M`);
      await vt.waitForRender();
      screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      expect(screen[fixLoginRow]).toContain('❯ fix-login');

      vt.sendInput(`\u001B[<0;8;${String(fixLoginRow + 1)}M`);
      vt.sendInput(`\u001B[<0;8;${String(fixLoginRow + 1)}m`);
      await vt.waitForRender();
      expect(handlers.onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'worktree', worktree: worktree('fix-login') }),
      );

      vt.sendInput(`\u001B[<65;8;${String(fixLoginRow + 1)}M`);
      vt.sendInput(`\u001B[<65;8;${String(fixLoginRow + 1)}M`);
      await vt.waitForRender();
      screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      const goneRow = screen.findIndex((line) => line.includes('gone'));
      expect(goneRow).toBeGreaterThan(0);

      vt.sendInput(`\u001B[<0;8;${String(goneRow + 1)}M`);
      vt.sendInput(`\u001B[<0;8;${String(goneRow + 1)}m`);
      await vt.waitForRender();
      expect(vt.getViewport().map((line) => stripVTControlCharacters(line)).join('\n')).toContain(
        "This worktree's directory is missing.",
      );
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });
});

describe('WorktreeFormComponent', () => {
  function makeForm(initialName?: string) {
    const handlers = { onSubmit: vi.fn(), onCancel: vi.fn() };
    const form = new WorktreeFormComponent({ initialName, ...handlers });
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

  it('prefills the Name field when initialName is supplied', () => {
    const { form, handlers, text } = makeForm('feat-haha');
    expect(text()).toMatch(/│ Name {2}feat-haha\s+│/);

    form.handleInput(ENTER);
    expect(handlers.onSubmit).toHaveBeenCalledWith({ name: 'feat-haha', base: undefined });
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

  it('focuses Name or Base when clicked with the mouse', () => {
    const { form, handlers, type } = makeForm();
    form.render(90);

    const clickBase = form.handleMouse(mouse({ type: 'press', button: 'left', x: 10, y: 2 }));
    expect(clickBase).toEqual({ handled: true, render: true });
    type('v2.0');

    const clickName = form.handleMouse(mouse({ type: 'press', button: 'left', x: 10, y: 1 }));
    expect(clickName).toEqual({ handled: true, render: true });
    type('clicked');
    form.handleInput(ENTER);

    expect(handlers.onSubmit).toHaveBeenCalledWith({ name: 'clicked', base: 'v2.0' });
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

  it('renders the Session row when canMoveSession is true and toggles via keyboard', () => {
    const handlers = { onSubmit: vi.fn(), onCancel: vi.fn() };
    const form = new WorktreeFormComponent({ canMoveSession: true, ...handlers });
    form.focused = true;
    const text = (): string => stripVTControlCharacters(form.render(90).join('\n').replaceAll(APC, ''));

    expect(text().split('\n')[1]).toMatch(/^│ Name {5}generated\s+│$/);
    expect(text().split('\n')[2]).toMatch(/^│ Base {5}HEAD\s+│$/);
    expect(text().split('\n')[3]).toMatch(/^│ Session {2}\[ Move current \] {2}Start new\s+│$/);

    form.handleInput(TAB);
    form.handleInput(TAB);
    expect(text().split('\n')[5]).toBe(' ←→ choose · Tab next field · Enter create · Esc cancel');

    form.handleInput('\u001B[C');
    expect(text().split('\n')[3]).toMatch(/^│ Session {2}Move current {2}\[ Start new \]\s+│$/);
    form.handleInput(ENTER);
    expect(handlers.onSubmit).toHaveBeenLastCalledWith({
      name: undefined,
      base: undefined,
      sessionAction: 'new',
    });

    form.handleInput(' ');
    form.handleInput(ENTER);
    expect(handlers.onSubmit).toHaveBeenLastCalledWith({
      name: undefined,
      base: undefined,
      sessionAction: 'move',
    });
  });

  it('supports clicking Session choices with the mouse in fullscreen mode even when unfocused', async () => {
    const handlers = { onSubmit: vi.fn(), onCancel: vi.fn() };
    const form = new WorktreeFormComponent({ canMoveSession: true, ...handlers });
    const vt = new VirtualTerminal(90, 12);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(form);
    ui.start();
    await vt.waitForRender();
    try {
      let screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      const sessionRow = screen.findIndex((line) => line.includes('Session'));
      expect(sessionRow).toBe(3);
      const startNewCol = screen[sessionRow]!.indexOf('Start new') + 2;

      vt.sendInput(`\u001B[<0;${String(startNewCol + 1)};${String(sessionRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(startNewCol + 1)};${String(sessionRow + 1)}m`);
      await vt.waitForRender();

      screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      expect(screen[sessionRow]).toContain('[ Start new ]');
      expect(form.focused).toBe(true);

      const moveCol = screen[sessionRow]!.indexOf('Move current') + 2;
      vt.sendInput(`\u001B[<0;${String(moveCol + 1)};${String(sessionRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(moveCol + 1)};${String(sessionRow + 1)}m`);
      await vt.waitForRender();

      screen = vt.getViewport().map((line) => stripVTControlCharacters(line));
      expect(screen[sessionRow]).toContain('[ Move current ]');

      vt.sendInput(ENTER);
      expect(handlers.onSubmit).toHaveBeenCalledWith({
        name: undefined,
        base: undefined,
        sessionAction: 'move',
      });
    } finally {
      ui.stop();
    }
  });
});

describe('createWorktreeDeletePrompt', () => {
  it('names every loss and what each delete option discards', () => {
    const text = promptText(
      removal({ uncommittedFiles: 3, commitsLostWithWorktree: 2, closedSessionCount: 1 }),
    );

    expect(text).toContain(' Delete worktree fix-login?');
    expect(text).toContain('~/.kimi-code/worktrees/wd_repo/fix-login');
    expect(text).toContain('3 uncommitted files will be lost.');
    expect(text).toContain('2 commits exist only in this worktree.');
    expect(text).toContain('1 earlier session worked here. Their conversation history stays available.');
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

  it('offers explicit Force delete options when submodules or a worktree lock are present', () => {
    const subText = promptText(removal({ hasSubmodules: true, branch: 'feat/sub' }));
    expect(subText).toContain('Contains git submodules. Force delete is required.');
    expect(subText).toContain('Force delete worktree');
    expect(subText).toContain('Force delete worktree and branch feat/sub');

    const lockedText = promptText(removal({ locked: true }));
    expect(lockedText).toContain(
      'This worktree is locked (for example, on a removable drive). Force delete is required.',
    );
    expect(lockedText).toContain('Force delete worktree');
  });

  it('offers to delete the branch, counting the commits only it holds', () => {
    const text = promptText(
      removal({ branch: 'feat-login', commitsLostWithBranch: 1, closedSessionCount: 2 }),
    );

    expect(text).toContain('1 commit exists only on branch feat-login.');
    expect(text).toContain('2 earlier sessions worked here. Their conversation history stays available.');
    expect(text).toMatch(/Delete worktree and branch feat-login\s+Discards 1 commit/);
    expect(text).not.toMatch(/Delete worktree\s+Discards/);
  });

  it('chooses with the arrow keys and keeps the worktree on Esc', () => {
    const onChoose = vi.fn();
    const prompt = createWorktreeDeletePrompt({
      removal: removal({ branch: 'feat-login' }),
      onChoose,
    });
    prompt.handleInput(DOWN);
    prompt.handleInput(DOWN);
    prompt.handleInput(ENTER);
    prompt.handleInput(ESC);

    expect(onChoose.mock.calls).toEqual([['delete-branch'], ['keep']]);
  });

  it('advertises Ctrl+C keep and exit on the leave-worktree prompt', () => {
    const prompt = createLeaveWorktreePrompt({ removal: removal(), onChoose: vi.fn() });
    const text = stripVTControlCharacters(prompt.render(100).join('\n'));
    expect(text).toContain('↑↓ navigate · Enter select · Esc stay · Ctrl+C keep and exit');
  });
});
