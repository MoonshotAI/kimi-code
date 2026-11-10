import { CURSOR_MARKER, type Component, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { currentTheme } from '#/tui/theme';
import type {
  DiffDisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';

import { captureProcessWrite } from '../../../helpers/process';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

/** The host focuses a panel when it mounts one in place of the editor. */
function mount(panel: ApprovalPanelComponent): ApprovalPanelComponent {
  panel.focused = true;
  return panel;
}

function makePending(): PendingApproval {
  return {
    data: {
      id: 'approval_1',
      tool_call_id: 'tool_1',
      tool_name: 'WriteFile',
      action: 'write a file',
      description: 'Update README.md',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
    },
  };
}

function makeDialog(): {
  dialog: ApprovalPanelComponent;
  responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }>;
} {
  const responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }> = [];
  const dialog = mount(new ApprovalPanelComponent(
    makePending(),
    (response) => responses.push(response),
  ));
  return { dialog, responses };
}

describe('ApprovalPanelComponent', () => {
  it('renders only numeric approval shortcuts in the hint', () => {
    const { dialog } = makeDialog();
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('1/2/3/4 choose');
    expect(out).not.toContain('y/a/n/f');
  });

  it('renders choice descriptions beneath the label when present', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_goal',
        tool_call_id: 'tool_goal',
        tool_name: 'CreateGoal',
        action: 'Creating a goal',
        description: '',
        display: [],
        choices: [
          {
            label: 'Switch to Never Ask and start',
            response: 'approved',
            selected_label: 'auto',
            description: 'Tools are approved automatically, and questions are skipped.',
          },
          { label: 'Do not start', response: 'cancelled', selected_label: 'cancel' },
        ],
      },
    };
    const out = strip(mount(new ApprovalPanelComponent(pending, () => {})).render(80).join('\n'));
    expect(out).toContain('1. Switch to Never Ask and start');
    expect(out).toContain('Tools are approved automatically, and questions are skipped.');
    // A choice without a description stays label-only — no stray blank helper line.
    expect(out).toContain('2. Do not start');
  });

  it('renders dangerous shell warnings with simple copy and no icon', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_danger',
        tool_call_id: 'tool_danger',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command: 'rm -rf /tmp/cache',
            danger: 'recursive delete',
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = mount(new ApprovalPanelComponent(pending, () => {}));

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Dangerous: recursive delete');
    expect(out).not.toContain('potentially destructive');
    expect(out).not.toContain('⚠');
  });

  it('wraps a long single-line shell command instead of truncating it', () => {
    const head = 'approve-long-command-head';
    const tail = 'approve-long-command-tail';
    const command = `printf ${head}_${'x'.repeat(220)}_${tail}`;
    const pending: PendingApproval = {
      data: {
        id: 'approval_long_command',
        tool_call_id: 'tool_long_command',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command,
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = mount(new ApprovalPanelComponent(pending, () => {}));

    const rendered = dialog.render(60);
    const out = strip(rendered.join('\n'));
    expect(rendered.length).toBeGreaterThan(8);
    expect(out).toContain(head);
    expect(out).toContain(tail);
    expect(out).not.toContain('...');
    expect(out).not.toContain('…');
  });

  it('numeric shortcuts still drive approval actions', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('2');
    expect(responses).toEqual([{ response: 'approved_for_session', feedback: undefined }]);
  });

  it('shortcut 4 enters feedback mode and submits the typed feedback', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'no' }]);
  });

  it('renders feedback input inline with the selected choice', () => {
    const { dialog } = makeDialog();
    dialog.handleInput('4');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('▶ 4. Reject with feedback');
    expect(out).not.toContain('\n  > ');
  });

  it('lends the keyboard to Updates on ctrl+n, even while typing feedback', () => {
    let updatesReady = false;
    const lent: string[] = [];
    const responses: unknown[] = [];
    const dialog = mount(new ApprovalPanelComponent(makePending(), (response) => responses.push(response), undefined, undefined, {
      onFocusUpdates: () => {
        lent.push('ctrl+n');
        return updatesReady;
      },
    }));

    dialog.handleInput('\u000E');
    expect(lent).toHaveLength(1);
    updatesReady = true;
    dialog.handleInput('\u000E');
    expect(responses).toEqual([]);
    dialog.handleInput('4');
    dialog.handleInput('\u001B[78;69u');
    dialog.handleInput('x');
    dialog.handleInput('\r');
    expect(lent).toHaveLength(3);
    expect(responses).toEqual([{ response: 'rejected', feedback: 'x', selected_label: undefined }]);
  });

  it('fades while another panel holds the keyboard or the window is inactive', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    onTestFinished(() => {
      chalk.level = previousLevel;
    });
    let terminalFocused = true;
    const dialog = mount(new ApprovalPanelComponent(makePending(), () => {}, undefined, undefined, {
      isTerminalFocused: () => terminalFocused,
    }));
    const faint = '\u001B[2m';
    const fadedThroughout = (lines: string[]): boolean =>
      lines.every(
        (line) =>
          line.length === 0 ||
          (line.startsWith(faint) && !/\u001B\[22m(?!\u001B\[2m)./u.test(line)),
      );
    const focusedLines = dialog.render(80);
    expect(focusedLines.join('\n')).not.toContain(faint);

    dialog.focused = false;
    const faded = dialog.render(80);
    expect(fadedThroughout(faded)).toBe(true);
    expect(faded.map(strip).at(-2)?.trim()).toBe('esc back to approval');
    expect(faded[0]).not.toBe(focusedLines[0]);
    expect(strip(faded.join('\n'))).toContain('▶ 1. Approve once');

    dialog.focused = true;
    terminalFocused = false;
    const away = dialog.render(80);
    expect(fadedThroughout(away)).toBe(true);
    expect(strip(away.join('\n'))).toBe(strip(focusedLines.join('\n')));
  });

  it('legacy y/a/n/f shortcuts no longer trigger approval actions', () => {
    for (const key of ['y', 'a', 'n', 'f']) {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([]);
    }
  });

  it('feedback input supports left/right cursor editing', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\u001B[D');
    dialog.handleInput('!');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'n!o' }]);
  });

  it('feedback input keeps editor shortcuts like ctrl+b / ctrl+f', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('a');
    dialog.handleInput('b');
    dialog.handleInput('c');
    dialog.handleInput('\u0002');
    dialog.handleInput('\u0002');
    dialog.handleInput('X');
    dialog.handleInput('\u0006');
    dialog.handleInput('Y');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'aXbYc' }]);
  });

  it('renders an IME cursor marker while editing feedback', () => {
    const { dialog } = makeDialog();
    dialog.focused = true;
    dialog.handleInput('4');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(CURSOR_MARKER);
  });

  it.each(['\u0003', '\u0004', '\u001B'])(
    'shortcut %j rejects approval immediately',
    (key) => {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([{ response: 'rejected' }]);
    },
  );

  it('renders ExitPlanMode with plan-specific header and plan-review choices', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          { label: 'Reject', response: 'rejected' },
          { label: 'Revise', response: 'rejected', requires_feedback: true },
        ],
      },
    };
    const dialog = mount(new ApprovalPanelComponent(pending, () => {}));

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Ready to build with this plan?');
    expect(out).not.toContain('Approve ExitPlanMode?');
    expect(out).toContain('Approve');
    expect(out).toContain('Reject');
    expect(out).toContain('Revise');
    expect(out).not.toContain('Approve for this session');
    expect(out).not.toContain('Investigate');
  });

  // Inline expand-in-place used to inflate the panel past the viewport on
  // any non-trivial Edit, which then collided with pi-tui's inline scroll
  // and made the terminal flicker / refuse to scroll. The panel now always
  // renders the diff in its compact cluster form; ctrl+e instead asks the
  // host to open a dedicated full-screen preview that can manage its own
  // scrolling.
  it('renders an Edit diff in compact form and asks the host to open a preview on ctrl+e', () => {
    const responses: Array<{ response: string }> = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const diffBlock: DiffDisplayBlock = {
      type: 'diff',
      path: 'src/foo.ts',
      old_text: oldLines.join('\n'),
      new_text: newLines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_diff',
        tool_call_id: 'tool_diff',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [diffBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let toolOutputToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = mount(new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      () => toolOutputToggles++,
      (block) => previewCalls.push(block),
    ));

    const before = strip(dialog.render(120).join('\n'));
    expect(before).toContain('+30');
    expect(before).toContain('-30');
    expect(before).toContain('ctrl+e preview');
    expect(before).not.toContain('new30'); // compact view stays compact

    dialog.handleInput('\u0005'); // Ctrl+E

    // The panel itself does not expand; it delegates to the host.
    const after = strip(dialog.render(120).join('\n'));
    expect(after).not.toContain('new30');
    expect(after).toContain('ctrl+e preview');
    expect(previewCalls).toEqual([diffBlock]);
    // The unrelated forward-only callback must not fire for ctrl+e.
    expect(toolOutputToggles).toBe(0);
    expect(responses).toEqual([]);
  });

  it('forwards ctrl+o to the global tool-output toggle without affecting the panel', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_forward',
        tool_call_id: 'tool_forward',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [
          {
            type: 'diff',
            path: 'src/foo.ts',
            old_text: Array.from({ length: 30 }, (_, i) => `old${String(i + 1)}`).join('\n'),
            new_text: Array.from({ length: 30 }, (_, i) => `new${String(i + 1)}`).join('\n'),
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let globalToggleCalls = 0;
    const dialog = mount(new ApprovalPanelComponent(pending, () => {}, () => globalToggleCalls++));

    dialog.handleInput('\u000F'); // Ctrl+O

    const after = strip(dialog.render(120).join('\n'));
    expect(globalToggleCalls).toBe(1);
    expect(after).toContain('ctrl+e preview');
    expect(after).not.toContain('new30');
  });

  it('does nothing on ctrl+e when there is nothing to preview', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan_only',
        tool_call_id: 'tool_plan_only',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [{ label: 'Approve', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = mount(new ApprovalPanelComponent(
      pending,
      () => {},
      undefined,
      (block) => previewCalls.push(block),
    ));

    dialog.handleInput('\u0005'); // Ctrl+E
    expect(previewCalls).toEqual([]);
  });

  it('renders Write as a syntax-highlighted code block (file_content), not a diff', () => {
    const responses: Array<{ response: string }> = [];
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`const x${String(i)} = ${String(i)};`);
    const contentBlock: FileContentDisplayBlock = {
      type: 'file_content',
      path: 'src/new.ts',
      content: lines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_write',
        tool_call_id: 'tool_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [contentBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = mount(new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      undefined,
      (block) => previewCalls.push(block),
    ));

    const collapsed = strip(dialog.render(120).join('\n'));
    // No diff markers, no +N -M header.
    expect(collapsed).not.toMatch(/^\s*\+\d+/m);
    expect(collapsed).not.toMatch(/^\s*-\d+/m);
    expect(collapsed).toContain('src/new.ts');
    expect(collapsed).toContain('const x1 = 1;');
    expect(collapsed).toContain('const x10 = 10;');
    expect(collapsed).not.toContain('const x25 = 25;');
    expect(collapsed).toContain('20 more lines hidden (ctrl+e to preview)');
    expect(collapsed).toContain('ctrl+e preview');

    dialog.handleInput('\u0005'); // Ctrl+E hands off to the host preview.
    const after = strip(dialog.render(120).join('\n'));
    // The panel itself stays compact; the full content is opened elsewhere.
    expect(after).not.toContain('const x30 = 30;');
    expect(previewCalls).toEqual([contentBlock]);
    expect(responses).toEqual([]);
  });

  it('renders unknown file_content extensions as plain text without stderr noise', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_unknown_write',
        tool_call_id: 'tool_unknown_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [{ type: 'file_content', path: 'demo.abcxyz', content: 'hello\nworld' }],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const stderr = captureProcessWrite('stderr');
    try {
      const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
      const dialog = mount(new ApprovalPanelComponent(
        pending,
        () => {},
        undefined,
        (block) => previewCalls.push(block),
      ));
      const collapsed = strip(dialog.render(120).join('\n'));
      expect(collapsed).toContain('hello');

      dialog.handleInput('\u0005'); // Ctrl+E
      expect(previewCalls).toHaveLength(1);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('returns feedback for plan-review revise choice', () => {
    const responses: Array<{
      response: string;
      feedback?: string | undefined;
      selected_label?: string | undefined;
    }> = [];
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          {
            label: 'Revise',
            response: 'rejected',
            selected_label: 'Revise',
            requires_feedback: true,
          },
        ],
      },
    };
    const dialog = mount(new ApprovalPanelComponent(
      pending,
      (response) => responses.push(response),
    ));

    dialog.handleInput('2');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([
      { response: 'rejected', feedback: 'no', selected_label: 'Revise' },
    ]);
  });

  it('shows the environment identifier next to the title for remote-bound sessions', () => {
    const pending = makePending();
    const withEnv: PendingApproval = {
      data: { ...pending.data, environment: 'ssh:dev-box' },
    };
    const dialog = new ApprovalPanelComponent(withEnv, () => {});
    const out = strip(dialog.render(80).join('\n'));
    const titleLine = out.split('\n').find((line) => line.includes('Approve WriteFile?'));
    expect(titleLine).toBeDefined();
    expect(titleLine).toContain('ssh:dev-box');
  });

  describe('docked (fullscreen)', () => {
    function goalPending(): PendingApproval {
      return {
        data: {
          ...makePending().data,
          tool_name: 'CreateGoal',
          choices: [
            {
              label: 'Switch to Never Ask and start',
              response: 'approved',
              description: 'Tools are approved automatically, and questions are skipped.',
            },
            { label: 'Start in Always Ask', response: 'approved', description: 'Ask every time.' },
            { label: 'Do not start', response: 'cancelled' },
          ],
        },
      };
    }

    function dockedDialog(
      pending: PendingApproval,
    ): { dialog: ApprovalPanelComponent; responses: Array<{ response: string }> } {
      const responses: Array<{ response: string }> = [];
      const dialog = mount(new ApprovalPanelComponent(
        pending,
        (response) => responses.push(response),
        undefined,
        undefined,
        { layout: { maxBodyRows: 6 } },
      ));
      return { dialog, responses };
    }

    function foot(dialog: ApprovalPanelComponent): string[] {
      const lines = dialog.render(60).map((line) => strip(line).trimEnd());
      return lines.slice(lines.findIndex((line) => line.includes('1. ')) - 1);
    }

    function mouse(type: 'move' | 'press' | 'release' | 'click', y: number): TuiMouseEvent {
      return {
        type,
        button: type === 'move' ? 'none' : 'left',
        x: 4,
        y,
        screenX: 4,
        screenY: y,
        width: 58,
        height: 12,
        shift: false,
        alt: false,
        ctrl: false,
      };
    }

    function footRow(dialog: ApprovalPanelComponent, label: string): number {
      return foot(dialog).findIndex((line) => line.includes(label));
    }

    function footPart(dialog: ApprovalPanelComponent): Component {
      return (dialog.children.at(-1) as GutterContainer).children[0]!;
    }

    it('shows only the selected description in a fixed area so the choices never move', () => {
      const { dialog } = dockedDialog(goalPending());
      const first = foot(dialog);
      expect(first).toEqual([
        '',
        '   ▶ 1. Switch to Never Ask and start',
        '     2. Start in Always Ask',
        '     3. Do not start',
        '',
        '   Tools are approved automatically, and questions are',
        '   skipped.',
        '',
        '   ↑/↓ select · 1/2/3 choose · ↵ confirm',
        ` ${'─'.repeat(58)}`,
      ]);

      dialog.handleInput('\u001B[B');
      dialog.handleInput('\u001B[B');
      const third = foot(dialog);
      expect(third).toHaveLength(first.length);
      expect(third.slice(1, 4)).toEqual([
        '     1. Switch to Never Ask and start',
        '     2. Start in Always Ask',
        '   ▶ 3. Do not start',
      ]);
      expect(third.slice(5, 7)).toEqual(['', '']);
    });

    it('cuts a long description to three rows so the key hint stays below it', () => {
      const pending = goalPending();
      pending.data.choices[0] = {
        ...pending.data.choices[0]!,
        description: Array.from({ length: 30 }, (_, i) => `word${String(i)}`).join(' '),
      };
      const { dialog } = dockedDialog(pending);
      const lines = foot(dialog);
      expect(lines.slice(4, 9).map((line) => line.length > 0)).toEqual([false, true, true, true, false]);
      expect(lines[7]).toMatch(/…$/);
      expect(lines[9]).toBe('   ↑/↓ select · 1/2/3 choose · ↵ confirm');
    });

    function click(dialog: ApprovalPanelComponent, row: number): unknown {
      let result: unknown;
      for (const type of ['press', 'release', 'click'] as const) result = footPart(dialog).handleMouse?.(mouse(type, row));
      return result;
    }

    function useClock(): (ms: number) => void {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(10_000);
      onTestFinished(() => {
        vi.useRealTimers();
      });
      return (ms) => {
        vi.setSystemTime(Date.now() + ms);
      };
    }

    it('highlights and previews a hovered choice without selecting it', () => {
      const previousLevel = chalk.level;
      chalk.level = 3;
      currentTheme.setTerminalBackground('#282C34');
      onTestFinished(() => {
        chalk.level = previousLevel;
        currentTheme.setTerminalBackground(undefined);
      });
      const { dialog } = dockedDialog(goalPending());
      const row = footRow(dialog, 'Start in Always Ask');
      const hoverBackground = '\u001B[48;2;51;55;63m';

      expect(footPart(dialog).handleMouse?.(mouse('move', row))).toEqual({ handled: true, render: true });
      expect(footPart(dialog).handleMouse?.(mouse('move', row))).toEqual({ handled: true });
      let lines = foot(dialog);
      expect(lines[row - 1]).toContain('▶ 1. Switch to Never Ask and start');
      expect(lines[row]).toBe('     2. Start in Always Ask');
      expect(lines).toContain('   Ask every time.');
      expect(dialog.render(60).find((line) => line.includes('Start in Always Ask'))).toContain(
        hoverBackground,
      );

      expect(footPart(dialog).handleMouse?.(mouse('move', footRow(dialog, '↑/↓ select')))).toEqual({
        handled: true,
        render: true,
      });
      lines = foot(dialog);
      expect(lines).not.toContain('   Ask every time.');
      expect(lines).toContain('   Tools are approved automatically, and questions are');
      expect(dialog.render(60).join('\n')).not.toContain(hoverBackground);

      footPart(dialog).handleMouse?.(mouse('move', row));
      dialog.handleInput('\u001B[B');
      dialog.handleInput('\u001B[B');
      expect(foot(dialog)).toContain('   ▶ 3. Do not start');
      expect(foot(dialog)).not.toContain('   Ask every time.');
    });

    it('has no hover effect without a terminal background color', () => {
      currentTheme.setTerminalBackground(undefined);
      const { dialog } = dockedDialog(goalPending());
      const row = footRow(dialog, 'Start in Always Ask');

      footPart(dialog).handleMouse?.(mouse('move', row));
      const lines = foot(dialog);
      expect(lines).not.toContain('   Ask every time.');
      expect(lines).toContain('   Tools are approved automatically, and questions are');
      expect(dialog.render(60).join('\n')).not.toContain('\u001B[4m');
    });

    it('submits a deliberate click while ignoring clicks right after the panel appeared', () => {
      const advance = useClock();
      const { dialog, responses } = dockedDialog(goalPending());
      const row = footRow(dialog, 'Do not start');

      advance(299);
      expect(click(dialog, row)).toEqual({ handled: true });
      expect(responses).toEqual([]);

      advance(1);
      click(dialog, row);
      expect(responses).toEqual([{ response: 'cancelled', feedback: undefined, selected_label: undefined }]);
    });

    it('only takes the keyboard back on the first click while faded', () => {
      const advance = useClock();
      const { dialog, responses } = dockedDialog(goalPending());
      const row = footRow(dialog, 'Do not start');
      advance(1_000);
      dialog.focused = false;

      expect(footPart(dialog).handleMouse?.(mouse('move', row))).toEqual({ handled: true });
      expect(foot(dialog)).not.toContain('   Ask every time.');
      expect(click(dialog, row)).toMatchObject({ handled: true, focus: true, focusTarget: dialog });
      expect(responses).toEqual([]);

      dialog.focused = true;
      click(dialog, row);
      expect(responses).toEqual([{ response: 'cancelled', feedback: undefined, selected_label: undefined }]);
    });

    it('only moves the selection on a click while typing feedback, keeping the text', () => {
      const advance = useClock();
      const { dialog, responses } = dockedDialog(makePending());
      advance(1_000);
      dialog.handleInput('4');
      for (const key of 'too risky') dialog.handleInput(key);

      click(dialog, footRow(dialog, '1. Approve once'));
      expect(responses).toEqual([]);
      expect(foot(dialog)).toContain('   ▶ 1. Approve once');

      click(dialog, footRow(dialog, '4. Reject with feedback'));
      expect(responses).toEqual([]);
      dialog.handleInput('\r');
      expect(responses).toEqual([{ response: 'rejected', feedback: 'too risky', selected_label: undefined }]);
    });
  });
});
