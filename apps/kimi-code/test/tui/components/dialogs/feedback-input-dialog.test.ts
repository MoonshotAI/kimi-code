import { stripVTControlCharacters } from 'node:util';

import {
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { promptFeedbackAttachment } from '#/tui/commands/prompts';
import {
  FeedbackInputDialogComponent,
  type FeedbackInputDialogResult,
} from '#/tui/components/dialogs/feedback-input-dialog';
import { darkColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(27);
const CTRL_C = String.fromCodePoint(3);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function strip(text: string): string {
  return stripVTControlCharacters(text).replaceAll(ANSI_RE, '');
}

beforeAll(() => {
  chalk.level = 3;
});

afterEach(() => {
  vi.useRealTimers();
});

function submit(dialog: FeedbackInputDialogComponent): void {
  vi.useFakeTimers();
  vi.advanceTimersByTime(150);
  dialog.handleInput('\r');
  vi.useRealTimers();
}

function makeDialog(rows = 40): {
  dialog: FeedbackInputDialogComponent;
  collected: FeedbackInputDialogResult[];
} {
  const collected: FeedbackInputDialogResult[] = [];
  const tui = {
    requestRender: vi.fn(),
    render: vi.fn(() => []),
    terminal: { rows, cols: 120 },
  } as unknown as TUI;
  const dialog = new FeedbackInputDialogComponent(tui, (result) => {
    collected.push(result);
  });
  dialog.focused = true;
  return { dialog, collected };
}

function mouse(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  options: { button?: TuiMouseEvent['button']; wheelDelta?: number; width?: number; height?: number } = {},
): TuiMouseEvent {
  return {
    type,
    button: options.button ?? (type === 'move' || type === 'wheel' ? 'none' : 'left'),
    x,
    y,
    screenX: x,
    screenY: y,
    width: options.width ?? 60,
    height: options.height ?? 12,
    shift: false,
    alt: false,
    ctrl: false,
    ...(options.wheelDelta !== undefined ? { wheelDelta: options.wheelDelta } : {}),
  };
}

describe('FeedbackInputDialogComponent', () => {
  it('renders the settings frame with a rounded input box', () => {
    const { dialog } = makeDialog();
    const rendered = dialog.render(60);
    const plain = rendered.map((line) => strip(line));

    expect(plain[0]).toBe('─'.repeat(60));
    expect(plain.at(-1)).toBe('─'.repeat(60));
    expect(plain.some((line) => line.startsWith('╭'))).toBe(false);
    expect(plain.join('\n')).toContain('Send feedback to Kimi Code');
    expect(plain.join('\n')).toContain("Tell us what's working or what's not.");
    expect(plain.join('\n')).toContain('Enter submit');
    expect(plain.join('\n')).toContain('Shift-Enter/Ctrl-J newline');
    expect(plain.join('\n')).toContain('Esc cancel');
  });

  it('uses the primary color for the rules and the input box', () => {
    const { dialog } = makeDialog();
    const rendered = dialog.render(60);
    const sample = chalk.hex(darkColors.primary)('x');
    const ansiOpen = sample.split('x')[0]!;
    expect(rendered[0]).toContain(`${ansiOpen}─`);
    expect(rendered.find((line) => strip(line).includes('╭'))).toContain(`${ansiOpen}╭`);
    expect(rendered.find((line) => strip(line).includes('╰'))).toContain(`${ansiOpen}╰`);
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog();

    for (const width of [39, 20, 10, 4]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('typing then pressing Enter submits the trimmed value', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'hello world ') {
      dialog.handleInput(ch);
    }
    submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'hello world' }]);
  });

  it('insets a three-line input box under the subtitle', () => {
    const { dialog } = makeDialog();
    const plain = dialog.render(60).map((line) => strip(line));
    const top = plain.findIndex((line) => line.includes('╭'));
    const bottom = plain.findIndex((line) => line.includes('╰'));

    expect(plain[top]).toBe(` ╭${'─'.repeat(56)}╮`);
    expect(bottom - top).toBe(4);
    expect(plain[top - 1]).toContain("Tell us what's working or what's not.");
    expect(plain.slice(top + 1, bottom).some((line) => line.includes('>'))).toBe(false);
  });

  it('renders and submits multiple lines', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'First line') dialog.handleInput(ch);
    dialog.handleInput('\n');
    for (const ch of 'Second line') dialog.handleInput(ch);

    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain('First line');
    expect(text).toContain('Second line');
    expect(text).not.toContain('> First line');

    submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'First line\nSecond line' }]);
  });

  it('inserts a newline for Caps Lock Ctrl-J and ignores its release', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'first') dialog.handleInput(ch);
    dialog.handleInput(`${ESC}[74;69u`);
    dialog.handleInput(`${ESC}[74;69:3u`);
    for (const ch of 'second') dialog.handleInput(ch);
    submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'first\nsecond' }]);
  });

  it('cancels on Caps Lock Ctrl-C', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(`${ESC}[67;69u`);
    expect(collected).toEqual([{ kind: 'cancel' }]);
  });

  it('supports Shift-Enter and editing an earlier line', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'first') dialog.handleInput(ch);
    dialog.handleInput(`${ESC}[13;2~`);
    for (const ch of 'second') dialog.handleInput(ch);
    dialog.handleInput(`${ESC}[A`);
    dialog.handleInput(`${ESC}[F`);
    dialog.handleInput('!');

    submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'first!\nsecond' }]);
  });

  it('preserves newlines in bracketed paste', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(`${ESC}[200~First\r\nSecond\nThird${ESC}[201~`);
    submit(dialog);

    expect(collected).toEqual([{ kind: 'ok', value: 'First\nSecond\nThird' }]);
  });

  it('keeps undo and word deletion shortcuts', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'hello world') dialog.handleInput(ch);
    dialog.handleInput(String.fromCodePoint(23));
    dialog.handleInput('there');
    dialog.handleInput(String.fromCodePoint(31));
    submit(dialog);

    expect(collected).toEqual([{ kind: 'ok', value: 'hello' }]);
  });

  it('collapses a long paste and submits its expanded multiline content', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(`${ESC}[200~${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')}${ESC}[201~`);

    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain('[paste #1 +15 lines]');

    submit(dialog);
    expect(collected).toEqual([
      { kind: 'ok', value: Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n') },
    ]);
  });

  it('Enter on an empty input does not submit and shows an inline empty hint', () => {
    const { dialog, collected } = makeDialog();
    submit(dialog);
    expect(collected).toEqual([]);
    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain('Feedback cannot be empty.');
    expect(text).not.toContain("Tell us what's working or what's not.");
  });

  it('typing again after the empty hint clears the hint', () => {
    const { dialog, collected } = makeDialog();
    submit(dialog);
    expect(strip(dialog.render(60).join('\n'))).toContain('Feedback cannot be empty.');
    dialog.handleInput('a');
    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain("Tell us what's working or what's not.");
    expect(text).not.toContain('Feedback cannot be empty.');
    expect(collected).toEqual([]);
  });

  it('Esc cancels the dialog', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(ESC);
    expect(collected).toEqual([{ kind: 'cancel' }]);
  });

  it('Ctrl-C cancels the dialog', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(CTRL_C);
    expect(collected).toEqual([{ kind: 'cancel' }]);
  });

  it('does not fire onDone twice', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput('h');
    dialog.handleInput('i');
    submit(dialog);
    submit(dialog);
    dialog.handleInput(ESC);
    expect(collected).toEqual([{ kind: 'ok', value: 'hi' }]);
  });

  it('positions the cursor accurately on wide clicks and consumes wheel without overflow', () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'hello') dialog.handleInput(ch);
    dialog.handleInput('\n');
    for (const ch of 'world') dialog.handleInput(ch);

    dialog.focused = false;
    const unfocusedLines = dialog.render(60).map(strip);
    const firstRow = unfocusedLines.findIndex((line) => line.includes('hello'));
    const secondRow = unfocusedLines.findIndex((line) => line.includes('world'));
    expect(firstRow).toBe(6);
    expect(secondRow).toBe(7);
    expect(unfocusedLines[firstRow]?.indexOf('hello')).toBe(3);

    expect(dialog.handleMouse(mouse('wheel', 5, firstRow, { wheelDelta: 1 }))).toBeUndefined();
    expect(dialog.handleMouse(mouse('press', 5, firstRow))).toEqual({ handled: true });
    expect(dialog.handleMouse(mouse('click', 5, firstRow))).toEqual({ handled: true, focus: true });

    dialog.focused = true;
    dialog.render(60);
    expect(dialog.handleMouse(mouse('wheel', 5, firstRow, { wheelDelta: 1 }))).toEqual({
      handled: true,
    });
    expect(dialog.handleMouse(mouse('wheel', 0, 1, { wheelDelta: -1 }))).toEqual({
      handled: true,
    });

    expect(dialog.handleMouse(mouse('click', 5, firstRow))).toEqual({ handled: true, focus: true });
    dialog.handleInput('X');
    dialog.render(60);

    expect(dialog.handleMouse(mouse('click', 6, secondRow))).toEqual({
      handled: true,
      focus: true,
    });
    dialog.handleInput('Y');
    dialog.render(60);

    expect(dialog.handleMouse(mouse('click', 3, firstRow))).toEqual({ handled: true, focus: true });
    dialog.handleInput('Z');

    submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'ZheXllo\nworYld' }]);
    expect(dialog.handleMouse(mouse('click', 3, firstRow))).toBeUndefined();
    expect(dialog.handleMouse(mouse('wheel', 3, firstRow, { wheelDelta: 1 }))).toBeUndefined();
  });

  it('positions the cursor accurately on narrow borderless renders', () => {
    for (const [width, textCol] of [
      [5, 2],
      [4, 1],
    ] as const) {
      const { dialog, collected } = makeDialog();
      dialog.handleInput('a');
      dialog.handleInput('\n');
      dialog.handleInput('b');

      const lines = dialog.render(width).map(strip);
      const firstRow = lines.findIndex((line) => line.includes('a'));
      const secondRow = lines.findIndex((line) => line.includes('b'));
      expect(firstRow).toBe(5);
      expect(secondRow).toBe(6);
      expect(lines[firstRow]?.indexOf('a')).toBe(textCol);

      expect(dialog.handleMouse(mouse('click', textCol, firstRow, { width }))).toEqual({
        handled: true,
        focus: true,
      });
      dialog.handleInput('1');
      const wrappedLines = dialog.render(width).map(strip);
      const shiftedSecondRow = wrappedLines.findIndex((line) => line.includes('b'));
      expect(shiftedSecondRow).toBe(7);

      expect(dialog.handleMouse(mouse('click', textCol + 1, shiftedSecondRow, { width }))).toEqual({
        handled: true,
        focus: true,
      });
      dialog.handleInput('2');

      submit(dialog);
      expect(collected).toEqual([{ kind: 'ok', value: '1a\nb2' }]);
    }
  });

  it('scrolls overflowing multi-line feedback with the mouse wheel and clicks scrolled lines', () => {
    const { dialog, collected } = makeDialog(15);
    for (let i = 1; i <= 10; i++) {
      for (const ch of `line ${String(i)}`) dialog.handleInput(ch);
      if (i < 10) dialog.handleInput('\n');
    }

    const atBottom = dialog.render(60).map(strip).join('\n');
    expect(atBottom).toContain('line 10');
    expect(atBottom).not.toContain('line 1\n');

    expect(dialog.handleMouse(mouse('wheel', 4, 7, { wheelDelta: -3 }))).toEqual({
      handled: true,
      render: true,
    });
    const scrolled = dialog.render(60).map(strip).join('\n');
    expect(scrolled).toContain('line 3');
    expect(scrolled).toContain('line 7');
    expect(scrolled).not.toContain('line 10');

    expect(dialog.handleMouse(mouse('wheel', 4, 7, { wheelDelta: -10 }))).toEqual({
      handled: true,
      render: true,
    });
    const atTopLines = dialog.render(60).map(strip);
    const line2Row = atTopLines.findIndex((line) => line.includes('line 2'));
    expect(line2Row).toBe(7);
    expect(dialog.handleMouse(mouse('wheel', 4, 7, { wheelDelta: -1 }))).toEqual({
      handled: true,
      render: false,
    });

    expect(dialog.handleMouse(mouse('click', 3, line2Row))).toEqual({ handled: true, focus: true });
    dialog.handleInput('!');
    submit(dialog);
    expect(collected[0]).toEqual({
      kind: 'ok',
      value: [
        'line 1',
        '!line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        'line 10',
      ].join('\n'),
    });
  });
});

describe('promptFeedbackAttachment', () => {
  it('omits No attachment and discloses submitted metadata, archives, and local session directory', () => {
    let mounted: Component | undefined;
    const host = {
      mountEditorReplacement: (component: Component) => {
        mounted = component;
      },
      restoreEditor: vi.fn(),
      state: { dockContainer: undefined },
    };

    void promptFeedbackAttachment(host as never, false, {
      sessionId: 'ses-42',
      sessionDir: '/tmp/sessions/ses-42',
      files: ['agents/main/wire.jsonl', 'logs/kimi-code.log', 'state.json'],
    });
    expect(mounted).toBeDefined();
    const rendered = strip(mounted!.render(100).join('\n'));

    expect(rendered).not.toContain('No attachment');
    expect(rendered).toContain('Current session logs');
    expect(rendered).toContain('Session logs + project code');
    expect(rendered).toContain('Choose what to include with your feedback');
    expect(rendered).toContain('session ID, request ID, model, CLI version, OS, and shell');
    expect(rendered).toContain('3 session files · showing 1–3');
    expect(rendered).toContain('  /tmp/sessions/ses-42/agents/main/wire.jsonl');
    expect(rendered).toContain('  /tmp/sessions/ses-42/state.json');
    expect(rendered).toContain('application log, which may mention other sessions');
    expect(rendered).not.toContain('manifest.json');
    expect(rendered).toContain('Secrets, dependencies,');
    expect(rendered).toContain('and build outputs are excluded.');
    expect(rendered).toContain('Current session · ses-42');
  });

  it('expands and pages through every current-session file', () => {
    let mounted: (Component & Focusable) | undefined;
    const host = {
      mountEditorReplacement: (component: Component & Focusable) => {
        mounted = component;
      },
      restoreEditor: vi.fn(),
      state: { dockContainer: undefined },
    };
    const files = Array.from(
      { length: 15 },
      (_, index) => `agents/main/task-${String(index)}.jsonl`,
    );
    void promptFeedbackAttachment(host as never, false, {
      sessionId: 'ses-42',
      sessionDir: '/tmp/sessions/ses-42',
      files,
    });
    expect(mounted).toBeDefined();
    const dialog = mounted as Component & Focusable & { handleInput: (data: string) => void };
    const collapsed = strip(dialog.render(100).join('\n'));
    expect(collapsed).toContain('/tmp/sessions/ses-42/agents/main/task-0.jsonl');
    expect(collapsed).not.toContain('/tmp/sessions/ses-42/agents/main/task-12.jsonl');
    expect(collapsed).toContain('15 session files · showing 1–5');
    expect(collapsed).toContain('10 more files · → next page');

    dialog.handleInput(`${ESC}[C`);
    const secondPage = strip(dialog.render(100).join('\n'));
    expect(secondPage).toContain('15 session files · showing 6–10');
    expect(secondPage).toContain('/tmp/sessions/ses-42/agents/main/task-5.jsonl');
    expect(secondPage).toContain('/tmp/sessions/ses-42/agents/main/task-9.jsonl');

    dialog.handleInput(`${ESC}[C`);
    const expanded = strip(dialog.render(100).join('\n'));
    expect(expanded).toContain('/tmp/sessions/ses-42/agents/main/task-10.jsonl');
    expect(expanded).toContain('/tmp/sessions/ses-42/agents/main/task-14.jsonl');
    expect(expanded).toContain('15 session files · showing 11–15');
    expect(expanded).not.toContain('0 more below');
    expect(expanded).toContain('← previous page');

    dialog.handleInput(`${ESC}[D`);
    dialog.handleInput(`${ESC}[B`);
    const collapsedAgain = strip(dialog.render(100).join('\n'));
    expect(collapsedAgain).toContain('Current session logs');
    for (const width of [100, 40, 20]) {
      expect(dialog.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it('offers only Logs only on remote sessions', () => {
    let mounted: Component | undefined;
    const host = {
      mountEditorReplacement: (component: Component) => {
        mounted = component;
      },
      restoreEditor: vi.fn(),
      state: { dockContainer: undefined },
    };

    void promptFeedbackAttachment(host as never, true);
    expect(mounted).toBeDefined();
    const rendered = strip(mounted!.render(100).join('\n'));

    expect(rendered).not.toContain('No attachment');
    expect(rendered).toContain('Current session logs');
    expect(rendered).not.toContain('Session logs + project code');
  });
});
