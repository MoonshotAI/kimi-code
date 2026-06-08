/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import { Editor, isKeyRelease, matchesKey, Key, type TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';

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

function getNewlineInput(data: string): string | undefined {
  if (data === '\n' || data === '\u001B\r' || data === '\u001B[13;2~') return data;
  if (matchesKey(data, Key.ctrl('j'))) return '\n';
  return undefined;
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  // Returns true when a plan card actually handled the toggle. When it
  // returns false (no plan in the transcript) the keystroke falls through
  // to pi-tui's default ctrl+e binding (move cursor to end of line).
  public onTogglePlanExpand?: () => boolean;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  public onUndo?: () => void;
  public onInsertNewline?: () => void;
  public onTextPaste?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so pi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onDownArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
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

  /**
   * `colors` is the live `ColorPalette` reference — the host mutates it
   * in place on theme switch (`Object.assign(state.theme.colors, ...)`), so
   * reading `this.colors.<token>` at render time always sees the
   * current theme without any setter plumbing. The `EditorTheme` that
   * pi-tui's `Editor` requires is derived from the same palette, and
   * `paddingX: 2` reserves the two leading columns where `render()`
   * paints the terminal-style `> ` prompt — both are implementation
   * details, not caller knobs.
   */
  constructor(
    tui: TUI,
    private readonly colors: ColorPalette,
  ) {
    // paddingX: 4 reserves column 0 for the left vertical border (│),
    // column 1 as a single space between border and prompt, column 2 for
    // the `>` prompt token, and column 3 as the space between prompt and
    // content. The right side mirrors with 3 padding columns and the right
    // border at the last column.
    super(tui, createEditorTheme(colors), { paddingX: 4 });
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

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const text = this.getText().trimStart();
    if (text.startsWith('/')) {
      // Paint only the FIRST editor content line; multi-line slash commands
      // are not a thing in practice.
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        const highlighted = highlightFirstSlashToken(original, this.colors.primary);
        if (highlighted !== undefined) {
          lines[firstContentIdx] = highlighted;
        }
      }
    }
    const firstContent = lines[firstContentIdx];
    if (firstContent !== undefined) {
      const withPrompt = injectPromptSymbol(firstContent);
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
    });
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data);
    if (isKeyRelease(normalized)) {
      return;
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

    if (matchesKey(normalized, Key.ctrl('e'))) {
      if (this.onTogglePlanExpand?.() === true) return;
      // No plan to toggle — fall through to pi-tui's end-of-line.
    }

    if (matchesKey(normalized, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(normalized, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('-'))) {
      this.onUndo?.();
    }

    const newlineInput = getNewlineInput(normalized);
    if (newlineInput !== undefined) {
      this.onInsertNewline?.();
      super.handleInput(newlineInput);
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

    super.handleInput(normalized);
  }
}

/**
 * Return a copy of `line` with the first `/token` coloured using `hex`.
 * For `/goal next manage`, also colour the command-path tokens.
 * `line` may already contain SGR escapes (cursor inverse, etc.); we
 * locate `/` via visible-index math so ANSI pass-through survives.
 * Returns `undefined` if no token is found.
 */
export function highlightFirstSlashToken(line: string, hex: string): string | undefined {
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
  return highlightVisibleRanges(line, ranges, hex);
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

function readTokenRange(
  visible: string,
  start: number,
): { start: number; end: number } | null {
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
  hex: string,
): string {
  let out = '';
  let rawCursor = 0;
  for (const range of ranges) {
    const rawStart = mapVisibleIdxToRaw(line, range.start);
    const rawEnd = mapVisibleIdxToRaw(line, range.end);
    out += line.slice(rawCursor, rawStart);
    out += chalk.hex(hex).bold(line.slice(rawStart, rawEnd));
    rawCursor = rawEnd;
  }
  return out + line.slice(rawCursor);
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
export function injectPromptSymbol(line: string): string | undefined {
  if (line.length < 4) return undefined;
  for (let i = 0; i < 4; i++) {
    if (line[i] !== ' ') return undefined;
  }
  return '  > ' + line.slice(4);
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
 */
export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
  options: { readonly connectedAbove?: boolean } = {},
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === '─') {
      const leftCorner = seenTop ? '╰' : options.connectedAbove === true ? '├' : '╭';
      const rightCorner = seenTop ? '╯' : options.connectedAbove === true ? '┤' : '╮';
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === ' ' ? paint('│') : (firstCh ?? '');
    const tail =
      line.length > 1 && lastCh === ' ' ? paint('│') : (lastCh ?? '');
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}
