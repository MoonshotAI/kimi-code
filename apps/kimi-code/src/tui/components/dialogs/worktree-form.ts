import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { focusOnUnfocusedMouse } from '#/tui/utils/dialog-mouse';

export type WorktreeFormField = 'name' | 'base';

export interface WorktreeFormValue {
  readonly name?: string;
  readonly base?: string;
}

export interface WorktreeFormOptions {
  readonly initialName?: string;
  readonly onSubmit: (value: WorktreeFormValue) => void;
  readonly onCancel: () => void;
}

const TITLE = 'New worktree';
const HINT = 'Tab next field · Enter create · Esc cancel';
const HELP = 'Leave Name empty for a generated name. Base takes a branch, tag, or commit.';
const FIELDS: readonly { readonly id: WorktreeFormField; readonly label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'base', label: 'Base' },
];
const PLACEHOLDERS: Record<WorktreeFormField, string> = { name: 'generated', base: 'HEAD' };
const LABEL_WIDTH = 6;

function fieldInput(placeholder: string): Input {
  return new Input({ prompt: '', placeholder, placeholderStyle: (text) => currentTheme.fg('textMuted', text) });
}

export class WorktreeFormComponent implements Component, Focusable {
  focused = false;
  private readonly inputs: Record<WorktreeFormField, Input> = {
    name: fieldInput(PLACEHOLDERS.name),
    base: fieldInput(PLACEHOLDERS.base),
  };
  private field: WorktreeFormField = 'name';
  private error: string | undefined;

  constructor(private readonly opts: WorktreeFormOptions) {
    if (opts.initialName !== undefined && opts.initialName.length > 0) {
      this.inputs.name.setValue(opts.initialName);
    }
  }

  showError(message: string, field?: WorktreeFormField): void {
    this.error = message;
    if (field !== undefined) this.field = field;
  }

  invalidate(): void {
    this.inputs.name.invalidate();
    this.inputs.base.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.opts.onCancel();
      return;
    }
    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift('tab')) ||
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down)
    ) {
      this.field = this.field === 'name' ? 'base' : 'name';
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSubmit({ name: this.value('name'), base: this.value('base') });
      return;
    }
    this.error = undefined;
    this.inputs[this.field].handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined;
    const fieldIndex = event.y - 1;
    const target = FIELDS[fieldIndex];
    if (target === undefined) return undefined;
    const changed = this.field !== target.id;
    this.field = target.id;
    return { handled: true, render: changed };
  }

  render(width: number): string[] {
    const border = (text: string): string => currentTheme.fg('primary', text);
    const innerWidth = Math.max(1, width - 4);
    const titleText = `─ ${TITLE} `;
    const lines = [
      border('╭') +
        border('─ ') +
        currentTheme.boldFg('primary', TITLE) +
        ' ' +
        border('─'.repeat(Math.max(0, width - 2 - visibleWidth(titleText))) + '╮'),
      ...FIELDS.map((field) => {
        const content = this.renderField(field, innerWidth);
        return `${border('│')} ${content}${' '.repeat(Math.max(0, innerWidth - visibleWidth(content)))} ${border('│')}`;
      }),
      border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
      currentTheme.fg('textMuted', ` ${HINT}`),
      this.error === undefined ? currentTheme.fg('textMuted', ` ${HELP}`) : currentTheme.fg('error', ` ${this.error}`),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderField(field: (typeof FIELDS)[number], width: number): string {
    const active = this.field === field.id;
    const label = active
      ? currentTheme.boldFg('accent', field.label.padEnd(LABEL_WIDTH))
      : currentTheme.fg('textDim', field.label.padEnd(LABEL_WIDTH));
    const input = this.inputs[field.id];
    input.focused = this.focused && active;
    const valueWidth = Math.max(1, width - LABEL_WIDTH);
    if (active) return label + (input.render(valueWidth)[0] ?? '');
    const value = input.getValue();
    return (
      label +
      (value === ''
        ? currentTheme.fg('textMuted', PLACEHOLDERS[field.id])
        : currentTheme.fg('text', truncateToWidth(value, valueWidth, '…')))
    );
  }

  private value(field: WorktreeFormField): string | undefined {
    const value = this.inputs[field].getValue().trim();
    return value === '' ? undefined : value;
  }
}
