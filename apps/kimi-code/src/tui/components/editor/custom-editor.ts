/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import {
  Editor,
  isKeyRelease,
  matchesKey,
  Key,
  SelectList,
  visibleWidth,
  type SelectItem,
  type TUI,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';
import { printableChar } from '#/tui/utils/printable-key';
import { isInsideTmux } from '#/tui/utils/terminal-notification';

import { extractAtPrefix } from './file-mention-provider';
import { WrappingSelectList } from './wrapping-select-list';

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';

// Kitty keyboard protocol CSI-u sequence: ESC [ keycode ; modifier[:eventType] u.
// We intentionally match only the simple two-field form — enough to rewrite
// `ctrl+<LETTER>` with caps_lock into `ctrl+<letter>` without caps_lock.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match CSI
const KITTY_CSI_U = /^\u001B\[(\d+);(\d+)((?::\d+)*)u$/;
// Kitty modifier bit layout: shift=1, alt=2, ctrl=4, super=8, hyper=16,
// meta=32, caps_lock=64, num_lock=128. Reported value is `mask + 1`.
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

// Mirror pi-tui's private SLASH_COMMAND_SELECT_LIST_LAYOUT
// (dist/components/editor.js); keep in sync when bumping pi-tui.
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
} as const;

/**
 * Workaround for a pi-tui bug that surfaces when Kitty keyboard protocol
 * is active AND caps_lock is on. In that state terminals emit, e.g.,
 * `ESC[68;69u` for ctrl+d (codepoint=68=`D`, modifier=ctrl|caps_lock).
 * pi-tui's `matchesKittySequence` masks `caps_lock` out of the *modifier*
 * but leaves the *codepoint* capitalised, so `matchesKey(data, "ctrl+d")`
 * (which expects codepoint=100=`d`) fails and every ctrl-shortcut is
 * silently dropped.
 *
 * We rewrite the sequence back to its unlocked form before dispatching,
 * but only when ctrl is held and shift is not — i.e. exactly the
 * `ctrl+<letter>` case. Plain uppercase (caps_lock only, no ctrl) and
 * explicit ctrl+shift+<letter> are left alone.
 */
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

/** Convert a visible-char index (ANSI-stripped) back to an index into the raw ANSI-bearing string. */
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

interface CustomEditorOptions {
  disablePasteBurst?: boolean;
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  /**
   * Fired for every input that is not a lone Escape. Used to disarm a pending
   * double-Esc so only two consecutive Escape presses trigger the shortcut.
   */
  public onNonEscapeInput?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  /** Return `true` to consume Ctrl+B; return `false`/`undefined` to fall through to the editor default (cursor-left). */
  public onCtrlB?: () => boolean;
  /** Return `true` to consume Ctrl+T (the todo list had overflow to toggle); return `false`/`undefined` to fall through to the editor default. */
  public onToggleTodoExpand?: () => boolean;
  public onUndo?: () => void;
  public onTextPaste?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so pi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onDownArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
  /** 'bash' when entering a `!` shell command. The `!` is never part of the
   *  text buffer — it is a separate mode + prompt symbol (see handleInput). */
  public inputMode: 'prompt' | 'bash' = 'prompt';
  public onInputModeChange?: (mode: 'prompt' | 'bash') => void;
  public connectedAbove = false;
  public borderHighlighted = false;
  /**
   * Called when the user triggers "paste image" (Ctrl-V on Unix,
   * Alt-V on Windows — Ctrl-V is terminal-reserved there). Return
   * `true` to consume the key (image was read and handled); return
   * `false` to let the key fall through to the normal paste path.
   * The callback may be async; pi-tui awaits it before dispatching
   * the next keystroke.
   */
  public onPasteImage?: () => Promise<boolean>;

  private consumingPaste = false;
  private consumeBuffer = '';
  private argumentHints: ReadonlyMap<string, string> = new Map();
  private autocompleteWasShowing = false;

  setArgumentHints(hints: ReadonlyMap<string, string>): void {
    this.argumentHints = hints;
  }

  constructor(tui: TUI, options: CustomEditorOptions = {}) {
    // paddingX: 4 reserves column 0 for the left vertical border (│),
    // column 1 as a single space between border and prompt, column 2 for
    // the `>` prompt token, and column 3 as the space between prompt and
    // content. The right side mirrors with 3 padding columns and the right
    // border at the last column.
    const theme = createEditorTheme();
    super(tui, theme, { paddingX: 4, disablePasteBurst: options.disablePasteBurst });

    // pi-tui keeps `createAutocompleteList` private; shadow it with an
    // instance property so slash command menus render descriptions wrapped
    // to at most two lines. Non-slash completion (paths, @ mentions) keeps
    // pi-tui's single-line list.
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

    // pi-tui auto-triggers autocomplete for `/` (and letters in a slash
    // context) with force:false, which routes through the slash-command
    // branch. In bash mode `/` is a path separator, not a command prefix, so
    // shadow the trigger to request file path completion (force:true) instead.
    // Prompt mode keeps the original force:false behaviour. `tryTriggerAutocomplete`
    // is private in pi-tui's typings but a plain prototype method at runtime.
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
      this.setText(newText);
      return true;
    }
    return false;
  }

  private hasAutocompleteActivity(): boolean {
    const autocomplete = this as unknown as AutocompleteInternals;
    return (
      this.isShowingAutocomplete() ||
      autocomplete.autocompleteAbort !== undefined ||
      autocomplete.autocompleteDebounceTimer !== undefined
    );
  }

  private cancelAutocompleteActivity(): void {
    // pi-tui exposes `isShowingAutocomplete()` but keeps cancellation private.
    // Kimi needs Esc to win over app-level cancel while the slash menu request is active.
    (this as unknown as AutocompleteInternals).cancelAutocomplete();
  }

  // Force a full re-render when the autocomplete dropdown closes, so the editor
  // snaps back to the bottom instead of sitting where the taller dropdown left it.
  // Only worthwhile when the session content already overflows one screen; below
  // that a full clear + home would pull the editor to the top and leave a blank
  // tail. Always skipped inside tmux, whose own reflow handles the shrink.
  private requestFullRenderOnAutocompleteClose(): void {
    if (isInsideTmux()) return;
    const { columns, rows } = this.tui.terminal;
    // Redraw when content fills or overflows the viewport. An exact fill (==
    // rows) is safe to clear (no blank tail) and still needs the redraw: the
    // differential renderer keeps the old viewport offset after a shrink.
    if (this.tui.render(columns).length < rows) return;
    this.tui.requestRender(true);
  }

  // Detect an autocomplete open→close edge from a render frame and force a full
  // re-render. Running from render() (not handleInput) also catches asynchronous
  // closes — e.g. Backspace deleting the leading `/`, where pi-tui only cancels
  // the menu once the provider re-query resolves. The render request is deferred
  // to a microtask so the overflow probe inside the helper does not re-enter
  // render() synchronously.
  private trackAutocompleteCloseForFullRender(): void {
    const showing = this.isShowingAutocomplete();
    const closed = this.autocompleteWasShowing && !showing;
    this.autocompleteWasShowing = showing;
    if (closed) {
      queueMicrotask(() => this.requestFullRenderOnAutocompleteClose());
    }
  }

  override render(width: number): string[] {
    this.trackAutocompleteCloseForFullRender();
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const isBash = this.inputMode === 'bash';
    const text = this.getText().trimStart();
    if (text.startsWith('/') && !isBash) {
      // Paint only the FIRST editor content line; multi-line slash commands
      // are not a thing in practice.
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        const highlighted = highlightFirstSlashToken(original, 'primary');
        if (highlighted !== undefined) {
          lines[firstContentIdx] = highlighted;
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
    // `this.borderColor` is pi-tui's per-render paint function. The host may
    // overwrite it (e.g. plan-mode / slash-context highlight via
    // `editor.borderColor = chalk.hex(primary)`), so we route corners and
    // side bars through the same hook to stay in sync.
    return wrapWithSideBorders(lines, (s) => this.borderColor(s), {
      connectedAbove: this.connectedAbove && !this.borderHighlighted,
      label: isBash ? ` ${currentTheme.boldFg('shellMode', '! shell mode')} ` : undefined,
    });
  }

  private computeArgumentHint(): string | undefined {
    // Argument hints describe slash commands, which do not exist in bash mode.
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

    // Any input other than a lone Escape breaks a pending double-Esc sequence,
    // so the shortcut only fires for two consecutive Escape presses.
    if (!matchesKey(normalized, Key.escape)) {
      this.onNonEscapeInput?.();
    }

    // When a paste marker was just expanded, discard the trailing bracketed
    // paste data that the terminal sends alongside the Ctrl-V keystroke.
    if (this.consumingPaste) {
      this.consumeBuffer += normalized;
      if (this.consumeBuffer.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = false;
        this.consumeBuffer = '';
      }
      return;
    }

    // If a bracketed paste arrives while the cursor sits on an existing
    // paste marker, expand that marker instead of pasting new content.
    if (normalized.includes(BRACKET_PASTE_START) && this.expandPasteMarkerAtCursor()) {
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    // Paste image binding — platform-aware:
    //   Windows terminals reserve Ctrl-V for their own paste handling
    //   (e.g. Windows Terminal's Ctrl+V shortcut), so we listen for
    //   Alt-V there. Everywhere else Ctrl-V pastes. When the host
    //   reports no image available, we fall through to pi-tui's
    //   normal paste path so text from the clipboard still works.
    const pasteKey = process.platform === 'win32' ? 'alt+v' : Key.ctrl('v');
    if (matchesKey(normalized, pasteKey)) {
      if (this.expandPasteMarkerAtCursor()) {
        return;
      }
      if (this.onPasteImage !== undefined) {
        const handler = this.onPasteImage;
        void handler().then((handled) => {
          if (!handled) {
            this.onTextPaste?.();
            super.handleInput.call(this, normalized);
          }
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
      // Only consume the key when the handler actually detached something;
      // otherwise fall through so readline's backward-char still works at the
      // idle prompt.
      if (this.onCtrlB?.() === true) return;
    }

    if (matchesKey(normalized, Key.ctrl('t'))) {
      // Only consume the key when the todo list actually has overflow to
      // expand/collapse; otherwise fall through to the editor default.
      if (this.onToggleTodoExpand?.() === true) return;
    }

    if (matchesKey(normalized, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('-'))) {
      this.onUndo?.();
    }

    // Exit bash mode: Backspace/Escape on an empty `!` prompt returns to prompt
    // mode. Because the `!` is not in the buffer, "deleting" it is really
    // "delete on empty bash input".
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
        // fall through to super so Editor's built-in history navigation runs
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

    // Swallow Tab while the autocomplete dropdown is closed so it does not
    // trigger pi-tui's built-in file completion. When the dropdown is open,
    // fall through so pi-tui can still accept the selected item with Tab.
    if (matchesKey(normalized, Key.tab) && !this.isShowingAutocomplete()) {
      return;
    }

    // Enter bash mode: typing `!` at the start of an empty prompt. The `!` is
    // not inserted into the buffer — it becomes the mode + prompt symbol, so the
    // cursor never has to skip over it and submit never has to strip it.
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
    super.handleInput(normalized);

    // Enter bash mode when `!...` is pasted into an empty prompt. The typed path
    // above handles the single `!` keystroke; this catches bracketed / Ctrl-V
    // pastes whose content starts with `!`. Strip the leading `!` so the buffer
    // holds only the command, exactly like the typed path.
    if (emptyPromptBeforeInput && this.inputMode === 'prompt' && this.getText().startsWith('!')) {
      this.inputMode = 'bash';
      this.onInputModeChange?.('bash');
      this.setText(this.getText().slice(1));
    }

    this.reopenAutocompleteAfterInput();
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
      // Use force:false so slash-aware logic runs: commands with argument
      // completions return their subcommands, commands without them return
      // null. force:true would bypass the slash branch and fall through to
      // path completion, wrongly popping up the file list.
      editor.requestAutocomplete?.({ force: false, explicitTab: false });
    };

    // Reopen path / argument completion right after a `/` is typed
    // (e.g. `/add-dir /` or an `@dir/` mention).
    if (textBeforeCursor.endsWith('/')) {
      const isAtMention = extractAtPrefix(textBeforeCursor) !== null;
      if (isAtMention) {
        trigger();
      } else if (this.inputMode === 'bash') {
        // In bash mode `/` is a path separator, not a slash command. A bare
        // leading `/` is already handled by the tryTriggerAutocomplete shadow
        // in the constructor; this branch covers the inline case (e.g. `ls /`,
        // `cat /etc/`, `/add-dir/`) that pi-tui never auto-triggers. force:true
        // is required so pi-tui's own slash-command handling is bypassed —
        // force:false would let it pop up subcommand completions.
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

    // After accepting a slash command name via Tab, pi-tui inserts a trailing
    // space and closes the menu without triggering argument completion. Reopen
    // it so subcommands (e.g. `/goal ` → status/pause/…) show immediately.
    // Skipped in bash mode: `/` is a path there, and force:false would let
    // pi-tui's own slash-command handling pop up subcommand completions.
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

/**
 * Return a copy of `line` with the first `/token` coloured using `hex`.
 * For `/goal next manage`, also colour the command-path tokens.
 * `line` may already contain SGR escapes (cursor inverse, etc.); we
 * locate `/` via visible-index math so ANSI pass-through survives.
 * Returns `undefined` if no token is found.
 */
export function highlightFirstSlashToken(line: string, token: 'primary'): string | undefined {
  const visible = stripSgr(line);
  const slashIdx = visible.indexOf('/');
  if (slashIdx < 0) return undefined;
  // Guard: only paint when `/` is the first non-whitespace character
  // on the line (avoids colouring a mid-sentence slash).
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return undefined;
  }
  // Token ends at the next whitespace (or the visible end).
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === ' ' || ch === '\t') break;
    endVisible++;
  }
  const visibleToken = visible.slice(slashIdx, endVisible);
  if (visibleToken.slice(1).includes('/')) return undefined;
  const ranges = [{ start: slashIdx, end: endVisible }];
  if (visibleToken === '/goal') {
    ranges.push(...goalCommandPathRanges(visible, endVisible));
  }
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

// Mirrors the editor's paddingX (see constructor). The hint is spliced into
// the first content line, which starts with this many spaces of left padding.
const EDITOR_LEFT_PADDING = 4;
// pi-tui renders the end-of-input cursor as an inverse-video space.
const CURSOR_BLOCK = '\u001B[7m \u001B[0m';

/**
 * Splice a dimmed argument-hint ghost string into the first content line.
 *
 * The hint is purely visual: it is appended after the typed command (and
 * after the cursor block when one is rendered) so the cursor stays at the
 * end of the real input. It consumes trailing padding space, so the line
 * width is preserved; if it would overflow the box it is truncated with an
 * ellipsis. Returns the line unchanged when there is no room for a hint.
 */
function injectArgumentHint(
  line: string,
  hint: string,
  realTextLength: number,
  width: number,
): string {
  const cursorIdx = line.indexOf(CURSOR_BLOCK);
  const cursorPresent = cursorIdx !== -1;
  const contentWidth = Math.max(1, width - EDITOR_LEFT_PADDING * 2);
  // Room left in the content area after the typed text (and cursor). The hint
  // must fit within this so the rendered line keeps its width.
  const available = contentWidth - realTextLength - (cursorPresent ? 1 : 0);
  const trimmed = truncateHint(hint, available);
  if (trimmed.length === 0) return line;
  const colored = currentTheme.fg('textDim', trimmed);
  const insertAt = cursorPresent
    ? cursorIdx + CURSOR_BLOCK.length
    : mapVisibleIdxToRaw(line, EDITOR_LEFT_PADDING + realTextLength);
  // Everything after the insertion point is trailing padding + right padding
  // (plain spaces). Replace it with the hint followed by the remaining spaces
  // so the visible line width is preserved.
  const trailing = line.length - insertAt;
  return line.slice(0, insertAt) + colored + ' '.repeat(Math.max(0, trailing - trimmed.length));
}

function truncateHint(hint: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (hint.length <= maxLen) return hint;
  if (maxLen === 1) return '…';
  return `${hint.slice(0, maxLen - 1)}…`;
}

/**
 * Overlay a terminal-style `> ` prompt symbol on the first content line.
 * Column 0 is reserved for the left vertical border (overlaid later by
 * wrapWithSideBorders); column 1 is a single-space gap, so the `>` token
 * lives at column 2 with column 3 separating it from content.
 * Relies on the editor being configured with `paddingX >= 4` so the line
 * starts with at least four literal spaces. Emits no SGR so the terminal's
 * default foreground colour renders the symbol. Returns `undefined` if the
 * line is too short or doesn't begin with the expected padding.
 */
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

/**
 * Post-process pi-tui's editor output to draw a full box around it.
 *
 * pi-tui only renders horizontal top/bottom borders; we wrap them with
 * `╭╮╰╯` corners and add vertical `│` bars on each row's outer columns.
 * Horizontal-border rows (those whose first visible char is `─`, including
 * scroll indicators like `── ↑ N more ──`) are stripped of their existing
 * SGR and repainted as a single box-drawn span. Content rows keep their
 * inner SGR intact; only column 0 and the last column are overlaid, and
 * only if they're literal spaces — that protects the cursor-overflow
 * case where the rightmost column is an SGR-tagged inverse cursor.
 *
 * When `options.label` is set, it is overlaid on the left of the top border
 * (e.g. the `! shell mode` badge), replacing the leading dashes. It is only
 * applied to a plain dash run, never to a `↑/↓ N more` scroll indicator.
 */
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
