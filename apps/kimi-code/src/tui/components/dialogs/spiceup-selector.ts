import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface SpiceupSelection {
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  maxTokens?: number | undefined;
  frequencyPenalty?: number | undefined;
  presencePenalty?: number | undefined;
}

export interface SpiceupSelectorOptions {
  readonly currentValues: SpiceupSelection;
  readonly onSubmit: (values: SpiceupSelection) => void;
  readonly onCancel: () => void;
}

interface SpiceField {
  readonly key: keyof SpiceupSelection;
  readonly label: string;
  readonly description: string;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly integer: boolean;
}

const FIELDS: readonly SpiceField[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    description: '0.0 = deterministic, 2.0 = very random',
    min: 0,
    max: 2,
    integer: false,
  },
  {
    key: 'topP',
    label: 'Top P',
    description: 'Nucleus sampling cutoff (0.0–1.0)',
    min: 0,
    max: 1,
    integer: false,
  },
  {
    key: 'topK',
    label: 'Top K',
    description: 'Limit token pool to top K candidates',
    min: 1,
    integer: true,
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    description: 'Maximum tokens to generate',
    min: 1,
    integer: true,
  },
  {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    description: 'Penalize repeated tokens (-2.0–2.0)',
    min: -2,
    max: 2,
    integer: false,
  },
  {
    key: 'presencePenalty',
    label: 'Presence penalty',
    description: 'Penalize repeated topics (-2.0–2.0)',
    min: -2,
    max: 2,
    integer: false,
  },
];

const FOOTER = '↑↓ navigate  ·  ↵ edit  ·  ctrl+s submit  ·  esc cancel';
const EDIT_FOOTER = '↵ save  ·  esc stop editing';

export class SpiceupSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly onSubmit: (values: SpiceupSelection) => void;
  private readonly onCancel: () => void;
  private readonly values: SpiceupSelection;
  private readonly inputs: Input[] = FIELDS.map(() => new Input());
  private focusedField = 0;
  private editing = false;
  private errorMessage: string | undefined;

  constructor(opts: SpiceupSelectorOptions) {
    super();
    this.onSubmit = opts.onSubmit;
    this.onCancel = opts.onCancel;
    this.values = { ...opts.currentValues };

    for (let i = 0; i < FIELDS.length; i++) {
      const field = FIELDS[i];
      if (field === undefined) continue;
      const input = this.inputs[i]!;
      const value = this.values[field.key];
      input.setValue(value !== undefined ? String(value) : '');
      input.onSubmit = () => {
        this.commitEdit();
        if (this.errorMessage === undefined) {
          this.editing = false;
        }
      };
    }
  }

  private currentField(): SpiceField | undefined {
    return FIELDS[this.focusedField];
  }

  private currentInput(): Input | undefined {
    return this.inputs[this.focusedField];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.editing) {
        this.editing = false;
        this.errorMessage = undefined;
        return;
      }
      this.onCancel();
      return;
    }

    if (matchesKey(data, Key.ctrl('s'))) {
      this.submit();
      return;
    }

    if (this.editing) {
      this.currentInput()?.handleInput(data);
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveFocus(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.moveFocus(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.editing = true;
      this.errorMessage = undefined;
    }
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of this.inputs) {
      input.invalidate();
    }
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(44, width);
    const innerWidth = Math.max(40, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const title = currentTheme.boldFg('textStrong', 'Spice up model sampling');
    const subtitle = currentTheme.fg(
      'textDim',
      'Set session-level overrides. Leave empty to clear.',
    );
    const footer = currentTheme.fg('textDim', this.editing ? EDIT_FOOTER : FOOTER);
    const error =
      this.errorMessage !== undefined ? currentTheme.fg('error', this.errorMessage) : undefined;

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    lines.push(
      border('│') +
        pad +
        truncateToWidth(title, innerWidth, '…') +
        ' '.repeat(Math.max(0, innerWidth - visibleWidth(title))) +
        border('│'),
    );
    lines.push(
      border('│') +
        pad +
        truncateToWidth(subtitle, innerWidth, '…') +
        ' '.repeat(Math.max(0, innerWidth - visibleWidth(subtitle))) +
        border('│'),
    );
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));

    for (let i = 0; i < FIELDS.length; i++) {
      const field = FIELDS[i];
      if (field === undefined) continue;
      const isFocused = i === this.focusedField;
      const input = this.inputs[i]!;
      const editingHere = this.editing && isFocused;
      input.focused = this.focused && editingHere;

      const label = isFocused
        ? currentTheme.boldFg('primary', `→ ${field.label}`)
        : currentTheme.fg('text', `  ${field.label}`);
      const desc = currentTheme.fg('textDim', field.description);
      const inputWidth = Math.max(10, innerWidth - 24);
      const rawInput = input.render(inputWidth)[0] ?? '> ';
      const inputLine = rawInput.startsWith('> ') ? rawInput.slice(2) : rawInput;
      const valueLine = currentTheme.fg(isFocused ? 'textStrong' : 'text', inputLine);

      const labelText = `${label}: ${valueLine}`;
      const labelPadding = Math.max(0, innerWidth - visibleWidth(labelText));
      lines.push(border('│') + pad + labelText + ' '.repeat(labelPadding) + border('│'));

      const descPadding = Math.max(0, innerWidth - visibleWidth(desc));
      lines.push(border('│') + pad + desc + ' '.repeat(descPadding) + border('│'));

      if (i < FIELDS.length - 1) {
        const spacerPadding = innerWidth;
        lines.push(border('│') + pad + ' '.repeat(spacerPadding) + border('│'));
      }
    }

    if (error !== undefined) {
      lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
      const errorPadding = Math.max(0, innerWidth - visibleWidth(error));
      lines.push(border('│') + pad + error + ' '.repeat(errorPadding) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    const footerPadding = Math.max(0, innerWidth - visibleWidth(footer));
    lines.push(border('│') + pad + footer + ' '.repeat(footerPadding) + border('│'));
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, width));
  }

  private moveFocus(delta: number): void {
    this.commitEdit();
    this.editing = false;
    this.focusedField =
      ((this.focusedField + delta) % FIELDS.length + FIELDS.length) % FIELDS.length;
    this.errorMessage = undefined;
  }

  private commitEdit(): void {
    this.errorMessage = undefined;
    const field = this.currentField();
    const input = this.currentInput();
    if (field === undefined || input === undefined) return;

    const raw = input.getValue().trim();
    if (raw.length === 0) {
      this.values[field.key] = undefined;
      return;
    }

    const num = field.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isFinite(num)) {
      this.errorMessage = `${field.label} must be a number`;
      return;
    }
    if (field.min !== undefined && num < field.min) {
      this.errorMessage = `${field.label} must be ≥ ${String(field.min)}`;
      return;
    }
    if (field.max !== undefined && num > field.max) {
      this.errorMessage = `${field.label} must be ≤ ${String(field.max)}`;
      return;
    }
    this.values[field.key] = num;
  }

  private submit(): void {
    this.commitEdit();
    if (this.errorMessage !== undefined) return;
    this.onSubmit({ ...this.values });
  }
}
