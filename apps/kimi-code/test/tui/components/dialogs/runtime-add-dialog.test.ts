import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RuntimeAddDialogComponent,
  type RuntimeAddDialogOptions,
} from '#/tui/components/dialogs/runtime-add-dialog';

const ENTER = '\r';
const TAB = '\t';

const SGR = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g');

function rendered(component: RuntimeAddDialogComponent, width = 80): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeDialog(overrides: Partial<RuntimeAddDialogOptions> = {}): RuntimeAddDialogComponent {
  const dialog = new RuntimeAddDialogComponent({
    type: 'ssh',
    existingIds: ['local'],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  });
  dialog.focused = true;
  // The first render assigns each field input's focused flag; keys sent before
  // it would land on unfocused inputs and be ignored.
  dialog.render(80);
  return dialog;
}

function typeText(dialog: RuntimeAddDialogComponent, text: string): void {
  for (const char of text) {
    dialog.handleInput(char);
  }
}

describe('RuntimeAddDialogComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('submits an ssh entry with the id derived from the host', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    typeText(dialog, 'dev-box');
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    typeText(dialog, '/home/me/projects');
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledWith({
      id: 'dev-box',
      entry: { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me/projects' },
    });
  });

  it('prefills the target field from an ssh host candidate', () => {
    const dialog = makeDialog({ initialTarget: 'dev-box' });
    expect(rendered(dialog)).toContain('dev-box');
  });

  it('submits a docker entry with an optional context', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ type: 'docker', onSubmit });
    typeText(dialog, 'myapp-dev');
    dialog.handleInput(TAB);
    typeText(dialog, 'orbstack');
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledWith({
      id: 'myapp-dev',
      entry: { type: 'docker', container: 'myapp-dev', context: 'orbstack', defaultCwd: undefined },
    });
  });

  it('splits command args on whitespace and drops the type field', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ type: 'command', onSubmit });
    typeText(dialog, 'sandbox');
    dialog.handleInput(TAB);
    typeText(dialog, 'ssh i-123 -- /home/me/.kimi-code/bin/kimi exec-server --listen stdio');
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledWith({
      id: 'sandbox',
      entry: {
        command: 'sandbox',
        args: ['ssh', 'i-123', '--', '/home/me/.kimi-code/bin/kimi', 'exec-server', '--listen', 'stdio'],
        defaultCwd: undefined,
      },
    });
  });

  it('rejects an empty target with an inline hint', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rendered(dialog)).toContain('Host cannot be empty.');
  });

  it('rejects a duplicate runtime id inline', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ existingIds: ['local', 'dev-box'], onSubmit });
    typeText(dialog, 'dev-box');
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rendered(dialog)).toContain('Runtime id "dev-box" already exists.');
  });

  it('rejects a reserved runtime id inline', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    typeText(dialog, 'host-a');
    dialog.handleInput(TAB);
    typeText(dialog, 'local');
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rendered(dialog)).toContain('Runtime id "local" is reserved.');
  });

  it('keeps the form editable after an engine-side validation error', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    dialog.showError('runtimes.dev-box.host: required');
    expect(rendered(dialog)).toContain('runtimes.dev-box.host: required');
    typeText(dialog, 'dev-box');
    dialog.handleInput(TAB);
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('locks input while busy', () => {
    const onSubmit = vi.fn();
    const dialog = makeDialog({ onSubmit });
    dialog.setBusy('Writing config.toml…');
    expect(rendered(dialog)).toContain('Writing config.toml…');
    dialog.handleInput(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
