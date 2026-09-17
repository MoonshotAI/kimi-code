/**
 * RuntimeAddDialogComponent — multi-field rounded box declaring a new runtime
 * (experimental remote runtime), per type: ssh (host, optionally prefilled
 * from the discovery candidates), docker (container + optional context), or a
 * custom command (program + space-separated args). The runtime id is derived
 * from the target when the id field is left empty. The last field is a
 * segmented scope control (DESIGN.md §8): `Global` writes the user-level
 * `config.toml`, `Project` the workspace's `.kimi-code/runtimes.toml`; the
 * subtitle states where the current scope lands.
 *
 * Geometry and keyboard mirror the custom-registry import dialog: Tab /
 * Shift-Tab / ↑↓ switch fields, Enter advances to the next field and submits
 * on the last one, Esc cancels; ←→ flips the scope while its row is focused.
 * Client-side checks stay minimal (required fields, id shape, duplicates) —
 * the engine validates the merged `[runtimes]` section on write and its error
 * surfaces inline via `showError`.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export type RuntimeAddType = 'ssh' | 'docker' | 'command';

/** Where the new declaration lands: user-level `config.toml` or the workspace's `.kimi-code/runtimes.toml`. */
export type RuntimeAddScope = 'global' | 'project';

export type RuntimeAddEntry =
  | { readonly type: 'ssh'; readonly host: string; readonly defaultCwd?: string }
  | {
      readonly type: 'docker';
      readonly container: string;
      readonly context?: string;
      readonly defaultCwd?: string;
    }
  | { readonly command: string; readonly args?: string[]; readonly defaultCwd?: string };

export interface RuntimeAddValue {
  readonly id: string;
  readonly entry: RuntimeAddEntry;
  readonly scope: RuntimeAddScope;
}

export interface RuntimeAddDialogOptions {
  readonly type: RuntimeAddType;
  /** Ids already registered or declared — reused ids are rejected inline. */
  readonly existingIds: readonly string[];
  /** Prefill for the target field (an ssh host candidate from the discovery layer). */
  readonly initialTarget?: string;
  readonly onSubmit: (value: RuntimeAddValue) => void;
  readonly onCancel: () => void;
}

type FieldId = 'target' | 'extra' | 'id' | 'defaultCwd' | 'scope';

interface FieldDef {
  readonly id: FieldId;
  readonly label: string;
  readonly required: boolean;
}

const SCOPE_FIELD_DEF: FieldDef = { id: 'scope', label: 'Scope', required: true };

const SCOPE_SUBTITLES: Record<RuntimeAddScope, string> = {
  global: 'Written to [runtimes] in config.toml.',
  project: 'Written to .kimi-code/runtimes.toml in this workspace.',
};

const FIELD_DEFS: Record<RuntimeAddType, readonly FieldDef[]> = {
  ssh: [
    { id: 'target', label: 'Host', required: true },
    { id: 'id', label: 'Runtime id (defaults to host)', required: false },
    { id: 'defaultCwd', label: 'Default cwd (optional)', required: false },
  ],
  docker: [
    { id: 'target', label: 'Container', required: true },
    { id: 'extra', label: 'Context (optional)', required: false },
    { id: 'id', label: 'Runtime id (defaults to container)', required: false },
    { id: 'defaultCwd', label: 'Default cwd (optional)', required: false },
  ],
  command: [
    { id: 'target', label: 'Command', required: true },
    { id: 'extra', label: 'Args (space-separated, optional)', required: false },
    { id: 'id', label: 'Runtime id (defaults to command)', required: false },
    { id: 'defaultCwd', label: 'Default cwd (optional)', required: false },
  ],
};

const TITLES: Record<RuntimeAddType, string> = {
  ssh: 'Add ssh runtime',
  docker: 'Add docker runtime',
  command: 'Add command runtime',
};

// Mirrors the engine's RESERVED_RUNTIME_IDS (apps cannot import engine code).
const RESERVED_IDS = new Set(['local', 'default']);
const ID_MAX_LENGTH = 64;

const FOOTER_NOT_LAST = 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel';
const MAX_ERROR_LINES = 4;

type DialogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export class RuntimeAddDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly fields: readonly FieldDef[];
  private readonly inputs = new Map<FieldId, Input>();
  private activeIndex = 0;
  private scope: RuntimeAddScope = 'global';
  private state: DialogState = { kind: 'idle' };
  private hint: string | undefined;

  constructor(private readonly opts: RuntimeAddDialogOptions) {
    super();
    this.fields = [...FIELD_DEFS[opts.type], SCOPE_FIELD_DEF];
    for (const field of this.fields) {
      if (field.id === 'scope') continue;
      const input = new Input();
      if (field.id === 'target' && opts.initialTarget !== undefined && opts.initialTarget.length > 0) {
        input.setValue(opts.initialTarget);
      }
      input.onSubmit = () => {
        this.advanceOrSubmit();
      };
      input.onEscape = () => {
        this.opts.onCancel();
      };
      this.inputs.set(field.id, input);
    }
  }

  /** Lock the dialog while the config write is in flight. */
  setBusy(message: string): void {
    this.state = { kind: 'busy', message };
    this.invalidate();
  }

  /** Show an engine-side validation failure inline; the form stays editable. */
  showError(message: string): void {
    this.state = { kind: 'error', message };
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.state.kind === 'busy') return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.focusField((this.activeIndex + 1) % this.fields.length);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.focusField((this.activeIndex - 1 + this.fields.length) % this.fields.length);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField(Math.min(this.fields.length - 1, this.activeIndex + 1));
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField(Math.max(0, this.activeIndex - 1));
      return;
    }
    if (this.state.kind === 'error') this.state = { kind: 'idle' };
    if (this.hint !== undefined) this.hint = undefined;
    if (this.fields[this.activeIndex]?.id === 'scope') {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
        this.scope = this.scope === 'global' ? 'project' : 'global';
      } else if (matchesKey(data, Key.enter)) {
        this.handleSubmit();
      }
      return;
    }
    this.activeInput()?.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of this.inputs.values()) input.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && this.state.kind !== 'busy';
    for (const [index, field] of this.fields.entries()) {
      const input = this.inputs.get(field.id);
      if (input !== undefined) input.focused = dialogActive && index === this.activeIndex;
    }

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', TITLES[this.opts.type]);
    const subtitleStyled = this.hint !== undefined
      ? currentTheme.fg('error', this.hint)
      : currentTheme.fg('textDim', SCOPE_SUBTITLES[this.scope]);
    const isLast = this.activeIndex === this.fields.length - 1;
    const footerStyled = currentTheme.fg('textDim', isLast ? FOOTER_LAST : FOOTER_NOT_LAST);

    const contentLines: string[] = [
      truncateToWidth(titleStyled, innerWidth, '…'),
      '',
      truncateToWidth(subtitleStyled, innerWidth, '…'),
      '',
    ];

    for (const [index, field] of this.fields.entries()) {
      const isScope = field.id === 'scope';
      const label = isScope && index === this.activeIndex ? `${field.label}  (←→ to switch)` : field.label;
      const labelStyled =
        index === this.activeIndex
          ? currentTheme.boldFg('accent', label)
          : currentTheme.fg('textDim', label);
      contentLines.push(truncateToWidth(labelStyled, innerWidth, '…'));
      contentLines.push(
        isScope
          ? truncateToWidth(this.renderScopeControl(), innerWidth, '…')
          : (this.inputs.get(field.id)?.render(innerWidth)[0] ?? '> '),
      );
      if (index < this.fields.length - 1) contentLines.push('');
    }

    contentLines.push('', truncateToWidth(footerStyled, innerWidth, '…'));

    if (this.state.kind === 'busy') {
      contentLines.push('', truncateToWidth(currentTheme.fg('textMuted', this.state.message), innerWidth, '…'));
    } else if (this.state.kind === 'error') {
      contentLines.push('');
      for (const line of this.state.message.split('\n').slice(0, MAX_ERROR_LINES)) {
        contentLines.push(truncateToWidth(currentTheme.fg('error', line), innerWidth, '…'));
      }
    }

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private activeInput(): Input | undefined {
    return this.inputs.get(this.fields[this.activeIndex]?.id ?? 'target');
  }

  private renderScopeControl(): string {
    const segment = (label: string, active: boolean): string =>
      active
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    return `  ${segment('Global', this.scope === 'global')} ${segment('Project', this.scope === 'project')}`;
  }

  private focusField(index: number): void {
    this.hint = undefined;
    this.activeIndex = index;
  }

  private advanceOrSubmit(): void {
    if (this.activeIndex < this.fields.length - 1) {
      this.focusField(this.activeIndex + 1);
      return;
    }
    this.handleSubmit();
  }

  private fieldValue(id: FieldId): string {
    return this.inputs.get(id)?.getValue().trim() ?? '';
  }

  private handleSubmit(): void {
    if (this.state.kind === 'busy') return;

    const idFieldIndex = this.fields.findIndex((field) => field.id === 'id');
    const target = this.fieldValue('target');
    if (target.length === 0) {
      this.hint = `${this.fields[0]?.label ?? 'Target'} cannot be empty.`;
      this.activeIndex = 0;
      return;
    }

    const idInput = this.fieldValue('id');
    const id = idInput.length > 0 ? idInput : target;
    if (id !== id.trim()) {
      this.hint = 'Runtime id must not have leading or trailing whitespace.';
      this.activeIndex = idFieldIndex;
      return;
    }
    if (id.length === 0 || id.length > ID_MAX_LENGTH) {
      this.hint = `Runtime id must be 1-${String(ID_MAX_LENGTH)} characters.`;
      this.activeIndex = idFieldIndex;
      return;
    }
    if (RESERVED_IDS.has(id)) {
      this.hint = `Runtime id "${id}" is reserved.`;
      this.activeIndex = idFieldIndex;
      return;
    }
    if (this.opts.existingIds.includes(id)) {
      this.hint = `Runtime id "${id}" already exists.`;
      this.activeIndex = idFieldIndex;
      return;
    }

    const defaultCwd = this.fieldValue('defaultCwd');
    const entry = this.buildEntry(target, defaultCwd);
    this.opts.onSubmit({ id, entry, scope: this.scope });
  }

  private buildEntry(target: string, defaultCwd: string): RuntimeAddEntry {
    const cwd = defaultCwd.length > 0 ? defaultCwd : undefined;
    switch (this.opts.type) {
      case 'ssh':
        return { type: 'ssh', host: target, defaultCwd: cwd };
      case 'docker': {
        const context = this.fieldValue('extra');
        return {
          type: 'docker',
          container: target,
          context: context.length > 0 ? context : undefined,
          defaultCwd: cwd,
        };
      }
      case 'command': {
        const argsText = this.fieldValue('extra');
        const args = argsText.length > 0 ? argsText.split(/\s+/).filter((part) => part.length > 0) : [];
        return { command: target, args: args.length > 0 ? args : undefined, defaultCwd: cwd };
      }
    }
  }
}
