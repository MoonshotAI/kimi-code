import {
  Editor,
  FAKE_CURSOR_END,
  FAKE_CURSOR_START,
  isKeyRelease,
  matchesKey,
  Key,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
  type TUI,
} from '@moonshot-ai/pi-tui';

import type { SubmitKey } from '#/tui/config';
import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';
import { printableChar } from '#/tui/utils/printable-key';

import { extractAtPrefix } from './file-mention-provider';
import { findInlineSkillTokens } from '../../utils/inline-skill-tokens';
import { WrappingSelectList } from './wrapping-select-list';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';

const KITTY_CSI_U = /^\u001B\[(\d+);(\d+)((?::\d+)*)u$/;
const CAPS_LOCK_BIT = 64;
const CTRL_BIT = 4;
const SHIFT_BIT = 1;

interface AutocompleteInternals {
  cancelAutocomplete(): void;
  readonly autocompleteAbort?: AbortController;
  readonly autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
}

interface AutocompleteListFactoryInternals {
  createAutocompleteList?: (prefix: string, items: SelectItem[]) => SelectList;
}

interface AutocompleteTriggerInternals {
  tryTriggerAutocomplete: (explicitTab?: boolean) => void;
  requestAutocomplete: (options: { force: boolean; explicitTab: boolean }) => void;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
} as const;

export function normalizeCapsLockedCtrl(data: string): string {
  const m = data.match(KITTY_CSI_U);
  if (m === null) return data;
  const codepoint = Number(m[1]);
  const modifierPlus1 = Number(m[2]);
  const tail = m[3] ?? '';
  if (!Number.isFinite(codepoint) || !Number.isFinite(modifierPlus1)) return data;
  const modifier = modifierPlus1 - 1;
  if ((modifier & CAPS_LOCK_BIT) === 0) return data;
  if ((modifier & CTRL_BIT) === 0) return data;
  if ((modifier & SHIFT_BIT) !== 0) return data;
  if (codepoint < 65 || codepoint > 90) return data;
  const loweredCodepoint = codepoint + 32;
  const strippedModifier = (modifier & ~CAPS_LOCK_BIT) + 1;
  return `\u001B[${String(loweredCodepoint)};${String(strippedModifier)}${tail}u`;
}

function mapVisibleIdxToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0;
  let i = 0;
  const re = new RegExp(ANSI_SGR.source, 'y');
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m !== null && m.index === i) {
      i += m[0].length;
    } else {
      visibleCount++;
      i++;
    }
  }
  return i;
}

function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, '');
}

function alternateSubmitKey(data: string): Exclude<SubmitKey, 'enter'> | undefined {
  if (matchesKey(data, 'ctrl+enter') || matchesKey(data, 'super+enter')) return 'mod-enter';
  if (matchesKey(data, Key.ctrl('q'))) return 'ctrl-q';
  return undefined;
}

interface CustomEditorOptions {
  disablePasteBurst?: boolean;
}

const BLOCK_CURSOR = /\u001B\[7m(.*?)\u001B\[0m/u;

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onNonEscapeInput?: () => void;
  public onPreInput?: (data: string) => boolean;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  public onCtrlB?: () => boolean;
  public onPageNotify?: () => boolean;
  public onUndo?: () => void;
  public onTextPaste?: () => void;
  public onUpArrowEmpty?: () => boolean;
  public onDownArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
  public inputMode: 'prompt' | 'bash' = 'prompt';
  public onInputModeChange?: (mode: 'prompt' | 'bash') => void;
  public connectedAbove = false;
  public borderHighlighted = false;
  public terminalFocused = true;
  public onPasteImage?: () => Promise<boolean>;

  private consumingPaste = false;
  private consumeBuffer = '';
  private pasteInFlight = false;
  private readonly pasteInputQueue: string[] = [];
  private argumentHints: ReadonlyMap<string, string> = new Map();
  private skillCommandNames: ReadonlySet<string> = new Set();
  private promptPrediction: string | undefined;
  private placeholder: string | undefined;
  private currentSubmitKey: SubmitKey = 'enter';

  get submitKey(): SubmitKey {
    return this.currentSubmitKey;
  }

  setArgumentHints(hints: ReadonlyMap<string, string>): void {
    this.argumentHints = hints;
  }

  setSkillCommandNames(names: ReadonlySet<string>): void {
    this.skillCommandNames = names;
  }

  setPromptPrediction(text: string | undefined): void {
    this.promptPrediction = text;
  }

  setPlaceholder(text: string | undefined): void {
    this.placeholder = text;
  }

  getPromptPrediction(): string | undefined {
    return this.promptPrediction;
  }

  acceptPromptPrediction(): boolean {
    const text = this.promptPrediction;
    if (text === undefined || this.getText().length > 0) return false;
    this.promptPrediction = undefined;
    this.setText(text);
    return true;
  }

  constructor(tui: TUI, options: CustomEditorOptions = {}) {
    const theme = createEditorTheme();
    super(tui, theme, {
      paddingX: 4,
      disablePasteBurst: options.disablePasteBurst,
      inlineSlashTrigger: true,
    });

    (this as unknown as AutocompleteListFactoryInternals).createAutocompleteList = (
      prefix,
      items,
    ) => {
      if (prefix.startsWith('/')) {
        return new WrappingSelectList(
          items,
          this.getAutocompleteMaxVisible(),
          theme.selectList,
          SLASH_COMMAND_SELECT_LIST_LAYOUT,
        );
      }
      return new SelectList(items, this.getAutocompleteMaxVisible(), theme.selectList);
    };

    const triggerInternals = this as unknown as AutocompleteTriggerInternals;
    triggerInternals.tryTriggerAutocomplete = (explicitTab = false) => {
      triggerInternals.requestAutocomplete({ force: this.inputMode === 'bash', explicitTab });
    };
  }

  override setDisablePasteBurst(disabled: boolean): void {
    super.setDisablePasteBurst(disabled);
  }

  public setInputMode(mode: 'prompt' | 'bash'): void {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.onInputModeChange?.(mode);
  }

  private expandPasteMarkerAtCursor(): boolean {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const currentLine = lines[line] ?? '';

    for (const match of currentLine.matchAll(PASTE_MARKER_RE)) {
      const start = match.index;
      const end = start + match[0].length;
      if (col < start || col > end) continue;

      const pasteId = Number(match[1]);
      const pastes = (this as unknown as { pastes: Map<number, string> }).pastes;
      const content = pastes.get(pasteId);
      if (content === undefined) return false;

      const text = this.getText();
      const offset = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + start;
      const newText = text.slice(0, offset) + content + text.slice(offset + match[0].length);
      this.setText(newText, { preservePasteRegistry: true });
      return true;
    }
    return false;
  }

  public hasAutocompleteActivity(): boolean {
    const autocomplete = this as unknown as AutocompleteInternals;
    return (
      this.isShowingAutocomplete() ||
      autocomplete.autocompleteAbort !== undefined ||
      autocomplete.autocompleteDebounceTimer !== undefined
    );
  }

  private cancelAutocompleteActivity(): void {
    (this as unknown as AutocompleteInternals).cancelAutocomplete();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const isBash = this.inputMode === 'bash';
    const text = this.getText().trimStart();
    if (!isBash) {
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        let highlighted = original;
        let leadingRange: { start: number; end: number } | null = null;
        if (text.startsWith('/')) {
          leadingRange = leadingSlashTokenRange(stripSgr(original));
          const leading = highlightFirstSlashToken(original, 'primary');
          if (leading !== undefined) {
            highlighted = leading;
          }
        }
        const inline = highlightInlineSkillTokens(
          highlighted,
          this.skillCommandNames,
          leadingRange,
          'primary',
        );
        if (inline !== undefined) {
          highlighted = inline;
        }
        if (highlighted !== original) {
          lines[firstContentIdx] = highlighted;
        }
      }
      for (let i = firstContentIdx + 1; i < lines.length - 1; i++) {
        const original = lines[i];
        if (original === undefined) continue;
        const inline = highlightInlineSkillTokens(original, this.skillCommandNames, null, 'primary');
        if (inline !== undefined) {
          lines[i] = inline;
        }
      }
    }
    const hint = this.computeArgumentHint();
    if (hint !== undefined) {
      const line = lines[firstContentIdx];
      if (line !== undefined) {
        lines[firstContentIdx] = injectArgumentHint(line, hint, this.getText().length, width);
      }
    }
    if (
      this.promptPrediction !== undefined &&
      this.inputMode === 'prompt' &&
      this.getText().length === 0 &&
      !this.hasAutocompleteActivity()
    ) {
      const line = lines[firstContentIdx];
      if (line !== undefined) {
        lines[firstContentIdx] = injectPromptPrediction(line, this.promptPrediction, width);
      }
    } else if (this.placeholder !== undefined && this.getText().length === 0) {
      const line = lines[firstContentIdx];
      if (line !== undefined) {
        lines[firstContentIdx] = injectPromptPrediction(line, this.placeholder, width);
      }
    }
    const firstContent = lines[firstContentIdx];
    if (firstContent !== undefined) {
      const withPrompt = injectPromptSymbol(
        firstContent,
        isBash ? '!' : '>',
        isBash ? (s) => this.borderColor(s) : undefined,
      );
      if (withPrompt !== undefined) {
        lines[firstContentIdx] = withPrompt;
      }
    }
    const inactive = !this.focused || !this.terminalFocused;
    const framed = wrapWithSideBorders(
      inactive
        ? lines.map((line) =>
            line
              .replace(BLOCK_CURSOR, '$1')
              .replaceAll(FAKE_CURSOR_START, '')
              .replaceAll(FAKE_CURSOR_END, ''),
          )
        : lines,
      (s: string) => this.borderColor(s),
      {
        connectedAbove: this.connectedAbove && !this.borderHighlighted,
        label: isBash ? ` ${currentTheme.boldFg('shellMode', '! shell mode')} ` : undefined,
      },
    );
    return inactive ? framed.map((line) => currentTheme.fade(line)) : framed;
  }

  private computeArgumentHint(): string | undefined {
    if (this.inputMode === 'bash') return undefined;
    const text = this.getText();
    const match = /^\/(\S+)( ?)$/.exec(text);
    if (match === null) return undefined;
    const cmd = match[1];
    const trailingSpace = match[2] ?? '';
    if (cmd === undefined) return undefined;
    const hint = this.argumentHints.get(cmd);
    if (hint === undefined) return undefined;
    const { line, col } = this.getCursor();
    if (line !== 0) return undefined;
    const currentLine = this.getLines()[0] ?? '';
    if (col !== currentLine.length) return undefined;
    return trailingSpace.length > 0 ? hint : ` ${hint}`;
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data);
    if (isKeyRelease(normalized)) {
      return;
    }

    if (this.pasteInFlight) {
      this.pasteInputQueue.push(normalized);
      return;
    }

    if (!matchesKey(normalized, Key.escape)) {
      this.onNonEscapeInput?.();
    }

    if (this.onPreInput?.(normalized) === true) {
      return;
    }

    if (this.consumingPaste) {
      this.consumeBuffer += normalized;
      if (this.consumeBuffer.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = false;
        this.consumeBuffer = '';
      }
      return;
    }

    if (normalized.includes(BRACKET_PASTE_START) && this.expandPasteMarkerAtCursor()) {
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    const pasteKey = process.platform === 'win32' ? 'alt+v' : Key.ctrl('v');
    if (matchesKey(normalized, pasteKey)) {
      if (this.expandPasteMarkerAtCursor()) {
        return;
      }
      if (this.onPasteImage !== undefined) {
        const handler = this.onPasteImage;
        const pasteAsText = (): void => {
          this.onTextPaste?.();
          super.handleInput.call(this, normalized);
        };
        this.pasteInFlight = true;
        void handler()
          .then((handled) => {
            if (!handled) pasteAsText();
          })
          .catch(() => {
            pasteAsText();
          })
          .finally(() => {
            this.pasteInFlight = false;
            this.flushPasteInputQueue();
          });
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('d'))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('g'))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('o'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('b'))) {
      if (this.onCtrlB?.() === true) return;
    }

    if (matchesKey(normalized, Key.ctrl('n'))) {
      if (this.onPageNotify?.() === true) return;
    }

    if (matchesKey(normalized, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('-'))) {
      this.onUndo?.();
    }

    if (
      this.inputMode === 'bash' &&
      this.getText().length === 0 &&
      (matchesKey(normalized, Key.escape) || matchesKey(normalized, Key.backspace))
    ) {
      this.inputMode = 'prompt';
      this.onInputModeChange?.('prompt');
      return;
    }

    if (matchesKey(normalized, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
      }
    }

    if (matchesKey(normalized, Key.down)) {
      if (this.getText().length === 0 && this.onDownArrowEmpty) {
        if (this.onDownArrowEmpty()) return;
      }
    }

    if (matchesKey(normalized, Key.escape)) {
      if (this.hasAutocompleteActivity()) {
        this.cancelAutocompleteActivity();
        return;
      }
      this.onEscape?.();
      return;
    }

    if (matchesKey(normalized, Key.tab) && !this.isShowingAutocomplete()) {
      return;
    }

    if (
      this.inputMode === 'prompt' &&
      printableChar(normalized) === '!' &&
      this.getText().length === 0
    ) {
      this.inputMode = 'bash';
      this.onInputModeChange?.('bash');
      return;
    }

    const emptyPromptBeforeInput = this.inputMode === 'prompt' && this.getText().length === 0;
    const submitKey = alternateSubmitKey(normalized);
    if (submitKey === undefined) {
      super.handleInput(normalized);
    } else {
      this.currentSubmitKey = submitKey;
      try {
        super.handleInput('\r');
      } finally {
        this.currentSubmitKey = 'enter';
      }
    }

    if (emptyPromptBeforeInput && this.inputMode === 'prompt' && this.getText().startsWith('!')) {
      this.inputMode = 'bash';
      this.onInputModeChange?.('bash');
      this.setText(this.getText().slice(1));
    }

    this.reopenAutocompleteAfterInput();
  }

  private flushPasteInputQueue(): void {
    if (this.pasteInFlight) return;
    const next = this.pasteInputQueue.shift();
    if (next === undefined) return;
    this.handleInput(next);
    if (!this.pasteInFlight) this.flushPasteInputQueue();
  }

  private reopenAutocompleteAfterInput(): void {
    if (this.isShowingAutocomplete()) return;
    const { line, col } = this.getCursor();
    const textBeforeCursor = this.getLines()[line]?.slice(0, col) ?? '';
    const editor = this as unknown as {
      requestAutocomplete?: (options: { force: boolean; explicitTab: boolean }) => void;
    };
    if (editor.requestAutocomplete === undefined) return;
    const trigger = (): void => {
      editor.requestAutocomplete?.({ force: false, explicitTab: false });
    };

    if (textBeforeCursor.endsWith('/')) {
      const isAtMention = extractAtPrefix(textBeforeCursor) !== null;
      if (isAtMention) {
        trigger();
      } else if (this.inputMode === 'bash') {
        if (textBeforeCursor.trimStart() !== '/') {
          editor.requestAutocomplete?.({ force: true, explicitTab: false });
        }
      } else {
        const isSlashArgument = textBeforeCursor.startsWith('/') && textBeforeCursor.includes(' ');
        if (isSlashArgument) {
          trigger();
        }
      }
      return;
    }

    if (
      this.inputMode !== 'bash' &&
      textBeforeCursor.endsWith(' ') &&
      textBeforeCursor.startsWith('/') &&
      textBeforeCursor.includes(' ')
    ) {
      trigger();
    }
  }
}

export function highlightFirstSlashToken(line: string, token: 'primary'): string | undefined {
  const visible = stripSgr(line);
  const range = leadingSlashTokenRange(visible);
  if (range === null) return undefined;
  const ranges = [range];
  if (visible.slice(range.start, range.end) === '/goal') {
    ranges.push(...goalCommandPathRanges(visible, range.end));
  }
  return highlightVisibleRanges(line, ranges, token);
}

function leadingSlashTokenRange(visible: string): { start: number; end: number } | null {
  const slashIdx = visible.indexOf('/');
  if (slashIdx < 0) return null;
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return null;
  }
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === ' ' || ch === '\t') break;
    endVisible++;
  }
  const visibleToken = visible.slice(slashIdx, endVisible);
  if (visibleToken.slice(1).includes('/')) return null;
  return { start: slashIdx, end: endVisible };
}

export function highlightInlineSkillTokens(
  line: string,
  skillCommandNames: ReadonlySet<string>,
  exclude: { start: number; end: number } | null,
  token: 'primary',
): string | undefined {
  if (skillCommandNames.size === 0) return undefined;
  const visible = stripSgr(line);
  const ranges = findInlineSkillTokens(visible, {
    isKnownSkill: (commandName) =>
      skillCommandNames.has(commandName) || skillCommandNames.has(`skill:${commandName}`),
    includeLeading: true,
  }).filter(
    (inlineToken) =>
      exclude === null || inlineToken.start >= exclude.end || inlineToken.end <= exclude.start,
  );
  if (ranges.length === 0) return undefined;
  return highlightVisibleRanges(line, ranges, token);
}

function goalCommandPathRanges(
  visible: string,
  commandEnd: number,
): Array<{ start: number; end: number }> {
  const nextRange = readTokenRange(visible, commandEnd);
  if (nextRange === null || visible.slice(nextRange.start, nextRange.end) !== 'next') {
    return [];
  }
  const ranges = [nextRange];
  const manageRange = readTokenRange(visible, nextRange.end);
  if (manageRange !== null && visible.slice(manageRange.start, manageRange.end) === 'manage') {
    ranges.push(manageRange);
  }
  return ranges;
}

function readTokenRange(visible: string, start: number): { start: number; end: number } | null {
  let tokenStart = start;
  while (tokenStart < visible.length && isTokenSpace(visible[tokenStart])) tokenStart++;
  if (tokenStart >= visible.length) return null;
  let tokenEnd = tokenStart;
  while (tokenEnd < visible.length && !isTokenSpace(visible[tokenEnd])) tokenEnd++;
  return { start: tokenStart, end: tokenEnd };
}

function isTokenSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function highlightVisibleRanges(
  line: string,
  ranges: Array<{ start: number; end: number }>,
  token: 'primary',
): string {
  let out = '';
  let rawCursor = 0;
  for (const range of ranges) {
    const rawStart = mapVisibleIdxToRaw(line, range.start);
    const rawEnd = mapVisibleIdxToRaw(line, range.end);
    out += line.slice(rawCursor, rawStart);
    out += currentTheme.boldFg(token, line.slice(rawStart, rawEnd));
    rawCursor = rawEnd;
  }
  return out + line.slice(rawCursor);
}

const EDITOR_LEFT_PADDING = 4;
const CURSOR_BLOCK = '\u001B[7m \u001B[0m';

function injectArgumentHint(
  line: string,
  hint: string,
  realTextLength: number,
  width: number,
): string {
  const cursorIdx = line.indexOf(CURSOR_BLOCK);
  const cursorPresent = cursorIdx !== -1;
  const contentWidth = Math.max(1, width - EDITOR_LEFT_PADDING * 2);
  const available = contentWidth - realTextLength - (cursorPresent ? 1 : 0);
  const trimmed = truncateHint(hint, available);
  if (trimmed.length === 0) return line;
  const colored = currentTheme.fg('textDim', trimmed);
  const insertAt = cursorPresent
    ? cursorIdx + CURSOR_BLOCK.length
    : mapVisibleIdxToRaw(line, EDITOR_LEFT_PADDING + realTextLength);
  const trailing = line.length - insertAt;
  return line.slice(0, insertAt) + colored + ' '.repeat(Math.max(0, trailing - trimmed.length));
}

function truncateHint(hint: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (hint.length <= maxLen) return hint;
  if (maxLen === 1) return '…';
  return `${hint.slice(0, maxLen - 1)}…`;
}

function injectPromptPrediction(line: string, prediction: string, width: number): string {
  const cursorIdx = line.indexOf(CURSOR_BLOCK);
  const cursorPresent = cursorIdx !== -1;
  const contentWidth = Math.max(1, width - EDITOR_LEFT_PADDING * 2);
  const available = contentWidth - (cursorPresent ? 1 : 0);
  if (available <= 0) return line;
  const preview = prediction.replaceAll(/\s+/g, ' ').trim();
  const trimmed = truncateToWidth(preview, available, '…');
  if (trimmed.length === 0) return line;
  const insertAt = cursorPresent
    ? cursorIdx + CURSOR_BLOCK.length
    : mapVisibleIdxToRaw(line, EDITOR_LEFT_PADDING);
  const trailing = line.slice(insertAt);
  const remaining = Math.max(0, visibleWidth(trailing) - visibleWidth(trimmed));
  return line.slice(0, insertAt) + currentTheme.fg('textMuted', trimmed) + ' '.repeat(remaining);
}

export function injectPromptSymbol(
  line: string,
  symbol = '>',
  paint?: (s: string) => string,
): string | undefined {
  if (line.length < 4) return undefined;
  for (let i = 0; i < 4; i++) {
    if (line[i] !== ' ') return undefined;
  }
  const rendered = paint ? paint(symbol) : symbol;
  return '  ' + rendered + ' ' + line.slice(4);
}

export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
  options: { readonly connectedAbove?: boolean; readonly label?: string } = {},
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === '─') {
      const isTop = !seenTop;
      const leftCorner = seenTop ? '╰' : options.connectedAbove === true ? '├' : '╭';
      const rightCorner = seenTop ? '╯' : options.connectedAbove === true ? '┤' : '╮';
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      if (isTop && options.label !== undefined && /^─+$/.test(middle)) {
        const labelWidth = visibleWidth(options.label);
        if (labelWidth <= middle.length) {
          return (
            paint(leftCorner) +
            options.label +
            paint('─'.repeat(middle.length - labelWidth)) +
            paint(rightCorner)
          );
        }
      }
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === ' ' ? paint('│') : (firstCh ?? '');
    const tail = line.length > 1 && lastCh === ' ' ? paint('│') : (lastCh ?? '');
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}
