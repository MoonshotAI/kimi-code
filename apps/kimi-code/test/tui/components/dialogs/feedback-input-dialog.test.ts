import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  FeedbackInputDialogComponent,
  type FeedbackInputDialogResult,
} from '#/tui/components/dialogs/feedback-input-dialog';
import { darkColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(27);
const CTRL_C = String.fromCodePoint(3);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function strip(text: string): string {
  return text.replaceAll(ANSI_RE, '');
}

beforeAll(() => {
  chalk.level = 3;
});

function makeDialog(): {
  dialog: FeedbackInputDialogComponent;
  collected: FeedbackInputDialogResult[];
} {
  const collected: FeedbackInputDialogResult[] = [];
  const dialog = new FeedbackInputDialogComponent((result) => {
    collected.push(result);
  });
  dialog.focused = true;
  return { dialog, collected };
}

describe('FeedbackInputDialogComponent', () => {
  it('renders a blue rounded box with title, subtitle, and footer', () => {
    const { dialog } = makeDialog();
    const text = strip(dialog.render(60).join('\n'));

    expect(text).toContain('╭');
    expect(text).toContain('╮');
    expect(text).toContain('╰');
    expect(text).toContain('╯');
    expect(text).toContain('Send feedback to Kimi Code');
    expect(text).toContain("Tell us what's working or what's not.");
    expect(text).toContain('Enter to submit');
    expect(text).toContain('Esc to cancel');
  });

  it('uses the primary color for the border', () => {
    const { dialog } = makeDialog();
    const rendered = dialog.render(60).join('\n');
    const sample = chalk.hex(darkColors.primary)('x');
    const ansiOpen = sample.split('x')[0]!;
    expect(rendered).toContain(`${ansiOpen}╭`);
    expect(rendered).toContain(`${ansiOpen}╰`);
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
    dialog.handleInput('\r');
    expect(collected).toEqual([{ kind: 'ok', value: 'hello world' }]);
  });

  it('Enter on an empty input does not submit and shows an inline empty hint', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput('\r');
    expect(collected).toEqual([]);
    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain('Feedback cannot be empty.');
    expect(text).not.toContain("Tell us what's working or what's not.");
  });

  it('typing again after the empty hint clears the hint', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput('\r');
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
    dialog.handleInput('\r');
    dialog.handleInput('\r');
    dialog.handleInput(ESC);
    expect(collected).toEqual([{ kind: 'ok', value: 'hi' }]);
  });
});
