import {
  CURSOR_MARKER,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import chalk from 'chalk';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  QuestionDialogComponent,
  type QuestionDialogOptions,
} from '#/tui/components/dialogs/question-dialog';
import { DOCK_PREVIEW_ROWS } from '#/tui/constant/rendering';
import type { PendingQuestion } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function flatten(text: string): string {
  return strip(text).replaceAll(/\s+/g, ' ').trim();
}

beforeAll(() => {
  chalk.level = 3;
});

function makePending(
  questions: PendingQuestion['data']['questions'],
  requestId = 'q_1',
): PendingQuestion {
  return {
    data: {
      id: requestId,
      tool_call_id: 'tc_1',
      questions,
    },
  };
}

function makeDialog(
  pending: PendingQuestion,
  onToggleToolOutput?: () => void,
  options?: QuestionDialogOptions,
): {
  dialog: QuestionDialogComponent;
  collected: string[][];
  methods: Array<string | undefined>;
} {
  const collected: string[][] = [];
  const methods: Array<string | undefined> = [];
  const dialog = new QuestionDialogComponent(
    pending,
    (response) => {
      collected.push(response.answers);
      methods.push(response.method);
    },
    6,
    onToggleToolOutput,
    options,
  );
  dialog.focused = true;
  return { dialog, collected, methods };
}

describe('QuestionDialogComponent', () => {
  it('single-select answers auto-advance and only submit from the review tab', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog, collected, methods } = makeDialog(pending);

    dialog.handleInput('2');
    expect(collected).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toMatch(/Q2\?/);

    dialog.handleInput('\r');
    expect(collected).toEqual([]);

    const reviewRaw = dialog.render(80).join('\n');
    const review = strip(reviewRaw);
    expect(review).toContain('Review your answer before submit');
    expect(review).toContain('Ready to submit your answers?');
    expect(review).not.toContain('? Ready to submit your answers?');
    expect(review).not.toContain('Please answer all questions before submitting.');
    expect(reviewRaw).toContain(
      currentTheme.boldFg('text', ' Review your answer before submit'),
    );
    expect(reviewRaw).toContain(currentTheme.fg('text', ' Ready to submit your answers?'));
    expect(review).toContain('B1');
    expect(review).toContain('A2');

    dialog.handleInput('1');
    expect(collected).toEqual([['B1', 'A2']]);
    expect(methods).toEqual(['enter']);
  });

  it('last single-select question goes straight to review instead of wrapping back', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);

    dialog.handleInput('\t');
    dialog.handleInput('2');

    const review = strip(dialog.render(80).join('\n'));
    expect(review).toContain('Review your answer before submit');
    expect(review).toContain('Some questions are still unanswered.');
    expect(review).toContain('B2');
    expect(review).toContain('Not answered');
    expect(collected).toEqual([]);
  });

  it('renders optional body text above options', () => {
    const pending = makePending([
      {
        question: 'Approve this plan?',
        body: '# Plan\n\n1. Make the focused change.',
        multi_select: false,
        options: [{ label: 'Approve' }, { label: 'Reject' }],
      },
    ]);
    const { dialog } = makeDialog(pending);
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('# Plan');
    expect(out).toContain('1. Make the focused change.');
    expect(out).toContain('Approve');
    expect(out).toContain('Other');
  });

  it('multi-select uses space and number keys to toggle choices', () => {
    const pending = makePending([
      {
        question: 'Pick many?',
        multi_select: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);

    dialog.handleInput(' ');
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\u001B[B');
    dialog.handleInput('3');
    dialog.handleInput('\t');

    const review = strip(dialog.render(80).join('\n'));
    expect(review).toContain('A, C');
    expect(review).not.toContain('Not answered');
    expect(collected).toEqual([]);
  });

  it('review shows an unanswered warning and still allows submit', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);

    dialog.handleInput('\t');
    dialog.handleInput('2');

    const before = strip(dialog.render(80).join('\n'));
    expect(before).toContain('Not answered');
    expect(before).toContain('Some questions are still unanswered.');

    dialog.handleInput('\r');
    expect(collected).toHaveLength(1);
    expect(collected[0]?.[0]).toBeUndefined();
    expect(collected[0]?.[1]).toBe('B2');
  });

  it('review cancel dismisses the whole request', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);

    dialog.handleInput('\t');
    dialog.handleInput('2');

    expect(collected).toEqual([[]]);
  });

  it('single-select Other input is inline and auto-advances after commit', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        other_label: 'Custom',
        other_description: 'Type your own answer',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected, methods } = makeDialog(pending);

    dialog.handleInput('3');
    let out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('→ [3] Custom:');
    expect(out).not.toContain('Type your own answer');

    dialog.handleInput('H');
    dialog.handleInput('i');
    dialog.handleInput('\r');

    out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Review your answer before submit');
    expect(out).toContain('Ready to submit your answers?');
    expect(out).not.toContain('? Ready to submit your answers?');
    expect(out).toContain('Hi');

    dialog.handleInput('1');
    expect(collected).toEqual([['Hi']]);
    expect(methods).toEqual(['enter']);
  });

  it('Other input supports left/right cursor editing before commit', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        other_label: 'Custom',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    dialog.handleInput('3');
    dialog.handleInput('H');
    dialog.handleInput('i');
    dialog.handleInput('\u001B[D');
    dialog.handleInput('!');
    dialog.handleInput('\r');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('H!i');
    expect(out).toContain('Review your answer before submit');
  });

  it('renders an IME cursor marker while editing Other when focused', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        other_label: 'Custom',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    dialog.handleInput('3');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(CURSOR_MARKER);
  });

  it('keeps selected options green even when the cursor returns to them', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    dialog.handleInput('\r');
    dialog.handleInput('\u001B[D');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(currentTheme.boldFg('success', '  → [1] A'));
    expect(out).not.toContain(currentTheme.fg('primary', '  → [1] A'));
  });

  it('stretches the border to the full available width', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    const lines = dialog.render(80);
    expect(strip(lines[0] ?? '')).toHaveLength(80);
    expect(strip(lines.at(-1) ?? '')).toHaveLength(80);
  });

  it('does not show the submit tab as completed when all questions are answered', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    dialog.handleInput('\r');
    dialog.handleInput('\r');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain(' Submit ');
    expect(out).not.toContain('(✓) Submit');
    expect(out).not.toContain('(○) Submit');
  });

  it('renders the active tab with a highlighted background instead of the circle marker', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        header: 'First',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        header: 'Second',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    const out = dialog.render(80).join('\n');
    expect(out).toContain(
      chalk.bgHex(currentTheme.color('primary')).hex(currentTheme.color('text')).bold(' First '),
    );
    expect(out).not.toContain('(●) First');
  });

  it('preserves Other drafts across tabs and question navigation', () => {
    const pending = makePending([
      {
        question: 'Pick toppings?',
        multi_select: true,
        options: [{ label: 'Cheese' }, { label: 'Pepperoni' }],
      },
    ]);
    const { dialog } = makeDialog(pending);

    dialog.handleInput('3');
    dialog.handleInput('M');
    dialog.handleInput('u');
    dialog.handleInput('s');
    dialog.handleInput('h');
    dialog.handleInput('r');
    dialog.handleInput('o');
    dialog.handleInput('o');
    dialog.handleInput('m');
    dialog.handleInput('\t');

    let out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Not answered');

    dialog.handleInput('\u001B[D');
    out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Other: Mushroom');

    dialog.handleInput('\r');
    dialog.handleInput('\r');
    dialog.handleInput('\t');
    out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Mushroom');
  });

  it('multi-select Other can be toggled off after it is committed', () => {
    const pending = makePending([
      {
        question: 'Pick toppings?',
        multi_select: true,
        options: [{ label: 'Cheese' }, { label: 'Pepperoni' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);

    dialog.handleInput('3');
    dialog.handleInput('M');
    dialog.handleInput('u');
    dialog.handleInput('s');
    dialog.handleInput('h');
    dialog.handleInput('r');
    dialog.handleInput('o');
    dialog.handleInput('o');
    dialog.handleInput('m');
    dialog.handleInput('\r');

    dialog.handleInput('3');
    dialog.handleInput('1');
    dialog.handleInput('\t');

    const review = strip(dialog.render(80).join('\n'));
    expect(review).toContain('Cheese');
    expect(review).not.toContain('Mushroom');

    dialog.handleInput('1');
    expect(collected).toEqual([['Cheese']]);
  });

  it('escape dismisses with empty answers array', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('\u001B');
    expect(collected).toEqual([[]]);
  });

  it.each(['\u0003', '\u0004'])('ctrl shortcut %j dismisses question dialog', (key) => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput(key);
    expect(collected).toEqual([[]]);
  });
  it('lends the keyboard to Updates on ctrl+n and fades until it comes back', () => {
    const pending = makePending([
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    let updatesReady = false;
    let terminalFocused = true;
    const lent: string[] = [];
    const { dialog, collected } = makeDialog(pending, undefined, {
      isTerminalFocused: () => terminalFocused,
      onFocusUpdates: () => {
        lent.push('ctrl+n');
        return updatesReady;
      },
    });
    const faint = '\u001B[2m';

    dialog.handleInput('\u000E');
    expect(lent).toEqual(['ctrl+n']);
    expect(dialog.render(80).join('\n')).not.toContain(faint);

    updatesReady = true;
    dialog.handleInput('\u001B[78;69u');
    expect(lent).toEqual(['ctrl+n', 'ctrl+n']);
    expect(collected).toEqual([]);

    dialog.focused = false;
    const faded = dialog.render(80);
    expect(faded.every((line) => line.length === 0 || line.startsWith(faint))).toBe(true);
    expect(faded.map(strip).at(-2)).toBe('  esc back to question');

    dialog.focused = true;
    terminalFocused = false;
    const away = dialog.render(80);
    expect(away.every((line) => line.length === 0 || line.startsWith(faint))).toBe(true);
    expect(away.map(strip).at(-2)).toContain('esc cancel');
  });

  it('forwards ctrl+o to the global tool-output toggle without answering', () => {
    let toggles = 0;
    const pending = makePending([
      { question: 'Q?', multi_select: false, options: [{ label: 'A' }] },
    ]);
    const { dialog, collected } = makeDialog(pending, () => toggles++);
    dialog.handleInput('\u000F');
    expect(toggles).toBe(1);
    expect(collected).toEqual([]);
  });

  describe('long-content wrapping', () => {
    const longQuestion =
      'Please confirm whether this dangerous shell command should really be executed in the current workspace, including all of its side effects on the filesystem and the network.';
    const longBody =
      'This single-line body description is intentionally written without any embedded newlines so the renderer is forced to wrap it across multiple rows instead of truncating with an ellipsis.';
    const longLabel =
      'Apply changes to every file under the current workspace including nested submodules and lockfiles';
    const longDescription =
      'This option will rewrite history on the remote branch and force-push, so collaborators will need to re-sync their local checkouts before continuing any work.';

    it('wraps the question text across multiple lines instead of truncating', () => {
      const pending = makePending([
        {
          question: longQuestion,
          multi_select: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ]);
      const { dialog } = makeDialog(pending);
      const rendered = dialog.render(40);
      const joined = rendered.map((line) => strip(line).trimEnd()).join('\n');
      const flat = flatten(rendered.join('\n'));

      expect(joined).not.toContain('…');
      expect(joined.split('\n').filter((l) => l.includes('?') || /Please|workspace|side/.test(l)).length).toBeGreaterThan(1);
      expect(flat).toContain(longQuestion);
    });

    it('wraps body lines that exceed the terminal width', () => {
      const pending = makePending([
        {
          question: 'Q?',
          body: longBody,
          multi_select: false,
          options: [{ label: 'A' }],
        },
      ]);
      const { dialog } = makeDialog(pending);
      const rendered = dialog.render(40);
      const joined = rendered.map((line) => strip(line).trimEnd()).join('\n');
      const flat = flatten(rendered.join('\n'));

      expect(joined).not.toContain('…');
      expect(flat).toContain(longBody);
    });

    it('wraps long option labels and descriptions', () => {
      const pending = makePending([
        {
          question: 'Q?',
          multi_select: false,
          options: [
            {
              label: longLabel,
              description: longDescription,
            },
          ],
        },
      ]);
      const { dialog } = makeDialog(pending);
      const rendered = dialog.render(40);
      const joined = rendered.map((line) => strip(line).trimEnd()).join('\n');
      const flat = flatten(rendered.join('\n'));

      expect(joined).not.toContain('…');
      expect(flat).toContain(longLabel);
      expect(flat).toContain(longDescription);
    });

    it('wraps long questions in the submit-tab review', () => {
      const pending = makePending([
        {
          question: longQuestion,
          multi_select: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ]);
      const { dialog } = makeDialog(pending);
      dialog.handleInput('1');
      const rendered = dialog.render(40);
      const joined = rendered.map((line) => strip(line).trimEnd()).join('\n');
      const flat = flatten(rendered.join('\n'));

      expect(joined).toContain('Review your answer before submit');
      expect(joined).not.toContain('…');
      expect(flat).toContain(longQuestion);
    });
  });

  describe('regular mode StableWindow mouse behavior', () => {
    function mouse(type: 'move' | 'wheel', y: number, wheelDelta?: number): TuiMouseEvent {
      return {
        type,
        button: 'none',
        x: 6,
        y,
        screenX: 6,
        screenY: y,
        width: 80,
        height: 12,
        shift: false,
        alt: false,
        ctrl: false,
        ...(wheelDelta === undefined ? {} : { wheelDelta }),
      };
    }

    it('updates selection on move without jittering the visible window and scrolls cleanly on wheel', () => {
      const pending = makePending([
        {
          question: 'Pick one?',
          multi_select: false,
          options: Array.from({ length: 10 }, (_, i) => ({ label: `Choice ${String(i + 1)}` })),
        },
      ]);
      const { dialog } = makeDialog(pending);
      const bodyPart = dialog.children[1] as Component;

      let bodyLines = bodyPart.render(80).map(strip);
      expect(bodyLines.join('\n')).toContain('showing 1-6 of 11');
      const choice6Row = bodyLines.findIndex((line) => line.includes('[6] Choice 6'));
      expect(choice6Row).toBeGreaterThan(-1);

      expect(bodyPart.handleMouse?.(mouse('move', choice6Row))).toEqual({
        handled: true,
        render: true,
      });
      bodyLines = bodyPart.render(80).map(strip);
      expect(bodyLines.join('\n')).toContain('→ [6] Choice 6');
      expect(bodyLines.join('\n')).toContain('showing 1-6 of 11');

      expect(bodyPart.handleMouse?.(mouse('wheel', choice6Row, 2))).toEqual({
        handled: true,
        render: true,
      });
      bodyLines = bodyPart.render(80).map(strip);
      expect(bodyLines.join('\n')).toContain('showing 3-8 of 11');
      expect(bodyLines.join('\n')).toContain('Choice 8');

      const choice3Row = bodyLines.findIndex((line) => line.includes('[3] Choice 3'));
      expect(bodyPart.handleMouse?.(mouse('move', choice3Row))).toEqual({
        handled: true,
        render: true,
      });
      bodyLines = bodyPart.render(80).map(strip);
      expect(bodyLines.join('\n')).toContain('→ [3] Choice 3');
      expect(bodyLines.join('\n')).toContain('showing 3-8 of 11');
    });
  });

  describe('fullscreen DockSection mouse support', () => {
    function screenRows(vt: VirtualTerminal): string[] {
      return vt.getViewport().map((row) => strip(row).trimEnd());
    }

    function useFakeClock(): (ms: number) => void {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(10_000);
      onTestFinished(() => {
        vi.useRealTimers();
      });
      return (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      };
    }

    async function mountDocked(
      pending: PendingQuestion,
      height = 18,
      width = 80,
    ): Promise<{
      dialog: QuestionDialogComponent;
      collected: string[][];
      methods: Array<string | undefined>;
      ui: TuiAltScreen;
      vt: VirtualTerminal;
      otherFocus: Component & { focused: boolean };
    }> {
      const { dialog, collected, methods } = makeDialog(pending, undefined, {
        layout: { maxBodyRows: DOCK_PREVIEW_ROWS },
      });
      const vt = new VirtualTerminal(width, height);
      const ui = new TuiAltScreen(vt);
      const transcript = new ScrollView(
        new Text(
          Array.from({ length: 40 }, (_, i) => `transcript ${String(i + 1)}`).join('\n'),
          0,
          0,
        ),
        { follow: 'end', primary: true },
      );
      const otherFocus: Component & { focused: boolean } = {
        focused: false,
        render: () => [],
        invalidate() {},
      };
      const root = new VStack();
      root.addChild(transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
      root.addChild(dialog, { basis: 'auto', grow: 0, shrink: 1, minSize: 3 });
      ui.setLayoutRoot(root);
      ui.setFocus(dialog);
      ui.start();
      onTestFinished(() => ui.stop());
      await vt.waitForRender();
      return { dialog, collected, methods, ui, vt, otherFocus };
    }

    async function clickCell(vt: VirtualTerminal, col: number, row: number): Promise<void> {
      vt.sendInput(`\u001B[<0;${String(col + 1)};${String(row + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(col + 1)};${String(row + 1)}m`);
      await vt.waitForRender();
    }

    async function moveCell(vt: VirtualTerminal, col: number, row: number): Promise<void> {
      vt.sendInput(`\u001B[<35;${String(col + 1)};${String(row + 1)}M`);
      await vt.waitForRender();
    }

    it('renders all options inside OverflowScrollView, scrolls via wheel without leaking, and reveals keyboard selection', async () => {
      const pending = makePending([
        {
          question: 'Choose a target?',
          multi_select: false,
          options: Array.from({ length: 12 }, (_, i) => ({ label: `Option ${String(i + 1)}` })),
        },
      ]);
      const { dialog, ui, vt } = await mountDocked(pending, 16, 80);

      let rows = screenRows(vt);
      expect(rows.join('\n')).not.toContain('showing ');
      expect(rows.some((row) => /[┃│]$/.test(row))).toBe(true);
      const opt1Row = rows.findIndex((row) => row.includes('[1] Option 1'));
      const opt4Row = rows.findIndex((row) => row.includes('[4] Option 4'));
      expect(opt1Row).toBeGreaterThan(0);
      expect(opt4Row).toBeGreaterThan(opt1Row);
      expect(rows.join('\n')).not.toContain('[12] Option 12');

      const transcriptTop = ui.viewportTop;
      expect(transcriptTop).toBeGreaterThan(0);

      await moveCell(vt, 8, opt4Row);
      rows = screenRows(vt);
      expect(rows[opt1Row]).toContain('[1] Option 1');
      expect(rows[opt4Row]).toContain('→ [4] Option 4');

      const headerRow = rows.findIndex((row) => row.includes('Choose a target?'));
      vt.sendInput(`\u001B[<64;8;${String(headerRow + 1)}M`);
      await vt.waitForRender();
      expect(ui.viewportTop).toBe(transcriptTop);

      vt.sendInput(`\u001B[<64;8;${String(rows.length)}M`);
      await vt.waitForRender();
      expect(ui.viewportTop).toBe(transcriptTop);

      for (let i = 0; i < 10; i++) vt.sendInput(`\u001B[<65;8;${String(opt4Row + 1)}M`);
      await vt.waitForRender();
      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('Other');
      expect(ui.viewportTop).toBe(transcriptTop);

      for (let i = 0; i < 10; i++) vt.sendInput(`\u001B[<64;8;${String(opt4Row + 1)}M`);
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('[1] Option 1');
      expect(ui.viewportTop).toBe(transcriptTop);

      for (let i = 0; i < 8; i++) dialog.handleInput('\u001B[B');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('→ [12] Option 12');
    });

    it('supports clickable tabs, single/multi-select clicks, Review jumps, and Submit/Cancel with enter method', async () => {
      const advance = useFakeClock();
      const pending = makePending([
        {
          question: 'Pick one?',
          header: 'First',
          multi_select: false,
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
        {
          question: 'Pick many?',
          header: 'Second',
          multi_select: true,
          options: [{ label: 'Red' }, { label: 'Blue' }],
        },
      ]);
      const { collected, methods, vt } = await mountDocked(pending, 20, 80);
      advance(500);

      let rows = screenRows(vt);
      const tabRow = rows.findIndex((row) => row.includes('First') && row.includes('Second'));
      const secondCol = rows[tabRow]!.indexOf('Second');
      await clickCell(vt, secondCol + 1, tabRow);

      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('Pick many?');
      const redRow = rows.findIndex((row) => row.includes('Red'));
      const blueRow = rows.findIndex((row) => row.includes('Blue'));
      await clickCell(vt, 8, redRow);
      await clickCell(vt, 8, blueRow);

      rows = screenRows(vt);
      const firstCol = rows[tabRow]!.indexOf('First');
      await clickCell(vt, firstCol + 1, tabRow);

      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('Pick one?');
      const betaRow = rows.findIndex((row) => row.includes('[2] Beta'));
      await clickCell(vt, 8, betaRow);

      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('Review your answer before submit');
      expect(rows.join('\n')).toContain('Beta');
      expect(rows.join('\n')).toContain('Red, Blue');

      const q1ReviewRow = rows.findIndex((row) => row.includes('Pick one?'));
      await clickCell(vt, 8, q1ReviewRow);
      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('? Pick one?');

      const submitTabCol = rows[tabRow]!.indexOf('Submit');
      await clickCell(vt, submitTabCol + 1, tabRow);
      rows = screenRows(vt);
      const cancelRow = rows.findIndex((row) => row.includes('[2] Cancel'));
      await moveCell(vt, 8, cancelRow);
      expect(screenRows(vt)[cancelRow]).toContain('→ [2] Cancel');

      const submitActionRow = rows.findIndex((row) => row.includes('[1] Submit'));
      await clickCell(vt, 8, submitActionRow);
      expect(collected).toEqual([['Beta', 'Red, Blue']]);
      expect(methods).toEqual(['enter']);
    });

    it('cancels from Review tab when clicking Cancel', async () => {
      const advance = useFakeClock();
      const pending = makePending([
        {
          question: 'Pick one?',
          multi_select: false,
          options: [{ label: 'Alpha' }],
        },
      ]);
      const { collected, vt } = await mountDocked(pending, 20, 80);
      advance(500);

      let rows = screenRows(vt);
      const tabRow = rows.findIndex((row) => row.includes('Submit'));
      const submitCol = rows[tabRow]!.indexOf('Submit');
      await clickCell(vt, submitCol + 1, tabRow);

      rows = screenRows(vt);
      const cancelRow = rows.findIndex((row) => row.includes('[2] Cancel'));
      await clickCell(vt, 8, cancelRow);
      expect(collected).toEqual([[]]);
    });

    it('positions cursor in Other input on click, suppresses hover while typing, and exits Other on clicking another option', async () => {
      const advance = useFakeClock();
      const pending = makePending([
        {
          question: 'Pick one?',
          multi_select: false,
          other_label: 'Custom',
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
      ]);
      const { dialog, collected, ui, vt } = await mountDocked(pending, 20, 80);
      advance(500);

      let rows = screenRows(vt);
      const otherRow = rows.findIndex((row) => row.includes('[3] Custom'));
      await clickCell(vt, 8, otherRow);

      for (const ch of 'hello') dialog.handleInput(ch);
      ui.requestRender();
      await vt.waitForRender();
      rows = screenRows(vt);
      const editingRow = rows.findIndex((row) => row.includes('[3] Custom: hello'));
      const alphaRow = rows.findIndex((row) => row.includes('[1] Alpha'));
      expect(editingRow).toBeGreaterThan(0);
      expect(alphaRow).toBeGreaterThan(0);

      await moveCell(vt, 8, alphaRow);
      rows = screenRows(vt);
      expect(rows[editingRow]).toContain('→ [3] Custom: hello');
      expect(rows[alphaRow]).not.toContain('→ [1] Alpha');

      const textStartCol = rows[editingRow]!.indexOf('hello');
      await clickCell(vt, textStartCol + 2, editingRow);
      dialog.handleInput('X');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt)[editingRow]).toContain('heXllo');

      await clickCell(vt, 5, editingRow);
      dialog.handleInput('Y');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt)[editingRow]).toContain('heXYllo');

      await clickCell(vt, 8, alphaRow);
      rows = screenRows(vt);
      expect(rows.join('\n')).toContain('Review your answer before submit');
      expect(rows.join('\n')).toContain('Alpha');
      expect(collected).toEqual([]);

      dialog.handleInput('\u001B[D');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('Custom: heXYllo');
    });

    it('focuses on unfocused click without selecting an option or switching tabs', async () => {
      const advance = useFakeClock();
      const pending = makePending([
        {
          question: 'Pick one?',
          header: 'First',
          multi_select: false,
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
        {
          question: 'Second?',
          header: 'Second',
          multi_select: false,
          options: [{ label: 'Gamma' }],
        },
      ]);
      const { dialog, collected, ui, vt, otherFocus } = await mountDocked(pending, 20, 80);
      advance(500);

      ui.setFocus(otherFocus);
      ui.requestRender();
      await vt.waitForRender();
      expect(dialog.focused).toBe(false);

      let rows = screenRows(vt);
      const betaRow = rows.findIndex((row) => row.includes('[2] Beta'));
      await clickCell(vt, 8, betaRow);
      expect(dialog.focused).toBe(true);
      expect(screenRows(vt).join('\n')).toContain('? Pick one?');
      expect(collected).toEqual([]);

      ui.setFocus(otherFocus);
      ui.requestRender();
      await vt.waitForRender();
      expect(dialog.focused).toBe(false);

      rows = screenRows(vt);
      const tabRow = rows.findIndex((row) => row.includes('First') && row.includes('Second'));
      const secondCol = rows[tabRow]!.indexOf('Second');
      await clickCell(vt, secondCol + 1, tabRow);
      expect(dialog.focused).toBe(true);
      expect(screenRows(vt).join('\n')).toContain('? Pick one?');

      await clickCell(vt, 8, betaRow);
      expect(screenRows(vt).join('\n')).toContain('? Second?');
    });
  });

});
