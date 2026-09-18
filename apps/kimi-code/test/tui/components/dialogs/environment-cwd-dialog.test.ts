import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  EnvironmentCwdDialogComponent,
  type EnvironmentCwdDialogOptions,
} from '#/tui/components/dialogs/environment-cwd-dialog';

const ESC = String.fromCodePoint(27);
const ENTER = '\r';

const SGR = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g');

function rendered(component: EnvironmentCwdDialogComponent, width = 80): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeDialog(overrides: Partial<EnvironmentCwdDialogOptions> = {}): EnvironmentCwdDialogComponent {
  const dialog = new EnvironmentCwdDialogComponent({
    title: 'Switch to ssh:dev-box',
    defaultValue: '/home/me/projects',
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  });
  dialog.focused = true;
  // The first render assigns the inner input's focused flag; keys sent before
  // it would land on an unfocused input and be ignored.
  dialog.render(80);
  return dialog;
}

describe('EnvironmentCwdDialogComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('prefills the input with the declaration defaultCwd', () => {
    const dialog = makeDialog();
    expect(rendered(dialog)).toContain('/home/me/projects');
  });

  it('submits the edited cwd on Enter', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/home/me/projects');
  });

  it('rejects an empty cwd with an inline hint instead of submitting', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ defaultValue: '', onSubmit });
    dialog.handleInput(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rendered(dialog)).toContain('Working directory cannot be empty.');
  });

  it('cancels on Esc', () => {
    const onCancel = vi.fn();
    const dialog = makeDialog({ onCancel });
    dialog.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a server-side validation failure inline and keeps editing', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    dialog.showError('cwd /nope is not a directory on environment dev-box');
    expect(rendered(dialog)).toContain('cwd /nope is not a directory on environment dev-box');
    // Typing clears the error and the dialog stays submittable.
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/home/me/projects');
  });

  it('locks input while busy and renders the busy message', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const dialog = makeDialog({ onSubmit, onCancel });
    dialog.setBusy('Connecting to dev-box…');
    expect(rendered(dialog)).toContain('Connecting to dev-box…');
    dialog.handleInput(ENTER);
    dialog.handleInput(ESC);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('bounds a multi-line handshake error', () => {
    const dialog = makeDialog();
    dialog.showError('exit code 127\nline2\nline3\nline4\nline5');
    const plain = rendered(dialog);
    expect(plain).toContain('line4');
    expect(plain).not.toContain('line5');
  });
});
