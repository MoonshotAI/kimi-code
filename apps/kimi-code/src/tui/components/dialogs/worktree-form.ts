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
import { printableChar } from '#/tui/utils/printable-key';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

export type WorktreeFormField = 'name' | 'base' | 'session';
export type WorktreeSessionAction = 'move' | 'new';

type TextFieldId = Exclude<WorktreeFormField, 'session'>;

export interface WorktreeFormValue {
  readonly name?: string;
  readonly base?: string;
  readonly sessionAction?: WorktreeSessionAction;
}

export interface WorktreeFormOptions {
  readonly initialName?: string;
  readonly canMoveSession?: boolean;
  readonly onSubmit: (value: WorktreeFormValue) => void;
  readonly onCancel: () => void;
}

const TITLE = 'New worktree';
const TEXT_HINT = 'Tab next field · Enter create · Esc cancel';
const SESSION_HINT = '←→ choose · Tab next field · Enter create · Esc cancel';
const HELP = 'Leave Name empty for a generated name. Base takes a branch, tag, or commit.';
const BASE_FIELDS: readonly { readonly id: WorktreeFormField; readonly label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'base', label: 'Base' },
];
const MOVE_FIELDS: readonly { readonly id: WorktreeFormField; readonly label: string }[] = [
  ...BASE_FIELDS,
  { id: 'session', label: 'Session' },
];
const PLACEHOLDERS: Record<TextFieldId, string> = { name: 'generated', base: 'HEAD' };
const BASE_LABEL_WIDTH = 6;
const MOVE_LABEL_WIDTH = 9;
const MOVE_LABEL = 'Move current';
const NEW_LABEL = 'Start new';
const OPTION_GAP = '  ';

function fieldInput(placeholder: string): Input {
  return new Input({ prompt: '', placeholder, placeholderStyle: (text) => currentTheme.fg('textMuted', text) });
}

function activePillText(label: string): string {
  return `[ ${label} ]`;
}

export class WorktreeFormComponent implements Component, Focusable {
  focused = false;
  private readonly shownAt = Date.now();
  private readonly inputs: Record<TextFieldId, Input> = {
    name: fieldInput(PLACEHOLDERS.name),
    base: fieldInput(PLACEHOLDERS.base),
  };
  private field: WorktreeFormField = 'name';
  private sessionAction: WorktreeSessionAction;
  private armedSubmitChoice: WorktreeSessionAction | undefined;
  private error: string | undefined;

  constructor(private readonly opts: WorktreeFormOptions) {
    if (opts.initialName !== undefined && opts.initialName.length > 0) {
      this.inputs.name.setValue(opts.initialName);
    }
    this.sessionAction = opts.canMoveSession === true ? 'move' : 'new';
  }

  private get canMove(): boolean {
    return this.opts.canMoveSession === true;
  }

  private get fields(): readonly { readonly id: WorktreeFormField; readonly label: string }[] {
    return this.canMove ? MOVE_FIELDS : BASE_FIELDS;
  }

  private get labelWidth(): number {
    return this.canMove ? MOVE_LABEL_WIDTH : BASE_LABEL_WIDTH;
  }

  showError(message: string, field?: WorktreeFormField): void {
    this.error = message;
    if (field !== undefined && this.fields.some((entry) => entry.id === field)) {
      this.field = field;
    }
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
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      this.stepField(1);
      return;
    }
    if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.up)) {
      this.stepField(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submit();
      return;
    }
    if (this.field === 'session') {
      if (
        matchesKey(data, Key.left) ||
        matchesKey(data, Key.right) ||
        printableChar(data) === ' '
      ) {
        this.error = undefined;
        this.sessionAction = this.sessionAction === 'move' ? 'new' : 'move';
      }
      return;
    }
    this.error = undefined;
    this.inputs[this.field].handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'drag') {
      this.armedSubmitChoice = undefined;
      return this.focused ? undefined : focusOnUnfocusedMouse(event);
    }
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) {
      return this.focused ? undefined : focusOnUnfocusedMouse(event);
    }
    const target = this.fields[event.y - 1];
    if (target === undefined) {
      this.armedSubmitChoice = undefined;
      return this.focused ? undefined : focusOnUnfocusedMouse(event);
    }
    const clicked = target.id === 'session' ? this.sessionOptionAt(event.x) : undefined;
    if (event.type === 'press') {
      this.armedSubmitChoice =
        this.focused &&
        this.field === 'session' &&
        clicked !== undefined &&
        clicked === this.sessionAction
          ? clicked
          : undefined;
      return { handled: true, render: this.selectTarget(target.id, clicked) };
    }
    const armed = this.armedSubmitChoice;
    this.armedSubmitChoice = undefined;
    const changed = this.selectTarget(target.id, clicked);
    if (!this.focused) {
      return { handled: true, focus: true, render: true };
    }
    if (armed !== undefined && armed === clicked && !isSettlingClick(this.shownAt)) {
      this.submit();
      return { handled: true, render: true };
    }
    return { handled: true, render: changed };
  }

  render(width: number): string[] {
    const border = (text: string): string => currentTheme.fg('primary', text);
    const innerWidth = Math.max(1, width - 4);
    const titleText = `─ ${TITLE} `;
    const hint = this.field === 'session' ? SESSION_HINT : TEXT_HINT;
    const lines = [
      border('╭') +
        border('─ ') +
        currentTheme.boldFg('primary', TITLE) +
        ' ' +
        border('─'.repeat(Math.max(0, width - 2 - visibleWidth(titleText))) + '╮'),
      ...this.fields.map((field) => {
        const content = this.renderField(field, innerWidth);
        return `${border('│')} ${content}${' '.repeat(Math.max(0, innerWidth - visibleWidth(content)))} ${border('│')}`;
      }),
      border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
      currentTheme.fg('textMuted', ` ${hint}`),
      this.error === undefined ? currentTheme.fg('textMuted', ` ${HELP}`) : currentTheme.fg('error', ` ${this.error}`),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  private stepField(delta: 1 | -1): void {
    const list = this.fields;
    const index = list.findIndex((entry) => entry.id === this.field);
    const next = (index + delta + list.length) % list.length;
    this.field = list[next]!.id;
  }

  private sessionOptionAt(x: number): WorktreeSessionAction | undefined {
    const start = 2 + this.labelWidth;
    const moveText = this.sessionAction === 'move' ? activePillText(MOVE_LABEL) : MOVE_LABEL;
    const newText = this.sessionAction === 'new' ? activePillText(NEW_LABEL) : NEW_LABEL;
    const moveEnd = start + moveText.length;
    const newStart = moveEnd + OPTION_GAP.length;
    const newEnd = newStart + newText.length;
    if (x >= start && x < moveEnd) return 'move';
    if (x >= newStart && x < newEnd) return 'new';
    return undefined;
  }

  private renderField(field: { readonly id: WorktreeFormField; readonly label: string }, width: number): string {
    const active = this.field === field.id;
    const padded = field.label.padEnd(this.labelWidth);
    const label = active ? currentTheme.boldFg('accent', padded) : currentTheme.fg('textDim', padded);
    if (field.id === 'session') {
      this.inputs.name.focused = false;
      this.inputs.base.focused = false;
      return label + this.renderSessionOptions(active);
    }
    const input = this.inputs[field.id];
    input.focused = this.focused && active;
    const valueWidth = Math.max(1, width - this.labelWidth);
    if (active) return label + (input.render(valueWidth)[0] ?? '');
    const value = input.getValue();
    return (
      label +
      (value === ''
        ? currentTheme.fg('textMuted', PLACEHOLDERS[field.id])
        : currentTheme.fg('text', truncateToWidth(value, valueWidth, '…')))
    );
  }

  private renderSessionOptions(rowActive: boolean): string {
    const renderChoice = (choice: WorktreeSessionAction, text: string): string => {
      if (this.sessionAction !== choice) return currentTheme.fg('textMuted', text);
      const pill = activePillText(text);
      return rowActive ? currentTheme.boldFg('accent', pill) : currentTheme.fg('text', pill);
    };
    return `${renderChoice('move', MOVE_LABEL)}${OPTION_GAP}${renderChoice('new', NEW_LABEL)}`;
  }

  private selectTarget(field: WorktreeFormField, choice: WorktreeSessionAction | undefined): boolean {
    let changed = this.field !== field;
    this.field = field;
    if (choice !== undefined && choice !== this.sessionAction) {
      this.sessionAction = choice;
      this.error = undefined;
      changed = true;
    }
    return changed;
  }

  private submit(): void {
    this.opts.onSubmit({
      name: this.value('name'),
      base: this.value('base'),
      ...(this.canMove ? { sessionAction: this.sessionAction } : {}),
    });
  }

  private value(field: TextFieldId): string | undefined {
    const value = this.inputs[field].getValue().trim();
    return value === '' ? undefined : value;
  }
}
