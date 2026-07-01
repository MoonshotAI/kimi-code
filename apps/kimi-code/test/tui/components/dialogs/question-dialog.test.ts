import { CURSOR_MARKER } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { beforeAll, describe, expect, it } from 'vitest';

import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import type { PendingQuestion } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

// Collapse all whitespace runs so wrapped content can be matched against its
// original (single-line) form without caring where the line break landed.
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
  );
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

    dialog.focused = true;
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
  it('forwards ctrl+o to the global tool-output toggle without answering', () => {
    let toggles = 0;
    const pending = makePending([
      { question: 'Q?', multi_select: false, options: [{ label: 'A' }] },
    ]);
    const { dialog, collected } = makeDialog(pending, () => toggles++);
    dialog.handleInput('\u000F'); // Ctrl+O
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
      // Question text should span multiple physical lines.
      expect(joined.split('\n').filter((l) => l.includes('?') || /Please|workspace|side/.test(l)).length).toBeGreaterThan(1);
      // And the full content should still be reconstructable.
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

});
