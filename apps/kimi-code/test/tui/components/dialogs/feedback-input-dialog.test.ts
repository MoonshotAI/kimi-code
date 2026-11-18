import { stripVTControlCharacters } from 'node:util';

import { visibleWidth, type Component, type Focusable } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
