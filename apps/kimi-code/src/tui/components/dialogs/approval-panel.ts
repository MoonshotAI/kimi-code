/**
 * ApprovalPanel — the approval request UI that replaces the editor.
 *
 * A DockSection: the title is the head, the request (command, diff, …) is the
 * body, and the choices with their key hints are the foot. Docked in
 * fullscreen, a long request scrolls (Shift+↑/↓, wheel) while the choices
 * stay on screen; the choices also take hover and clicks. `Ctrl+N` lends the
 * keyboard to the Updates panel; meanwhile the panel fades.
 */

import {
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@moonshot-ai/pi-tui';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { normalizeCapsLockedCtrl } from '#/tui/components/editor/custom-editor';
import { currentTheme } from '#/tui/theme';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

import { paintHoverRow } from './hover-row';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import type {
  ApprovalPanelChoice,
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';

export interface ApprovalPanelResponse {
  readonly response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
  readonly selected_label?: string | undefined;
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

const DIFF_SUMMARY_MAX_LINES = 10;
// Rows of the docked description area; a longer description is cut so the
// key hint below it stays on screen.
const DESCRIPTION_AREA_MAX_ROWS = 3;
const CONTENT_SUMMARY_MAX_LINES = 10;

interface BlockStyles {
  strong: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  gutter: (s: string) => string;
  errorBold: (s: string) => string;
}

function makeBlockStyles(): BlockStyles {
  return {
    strong: (s) => currentTheme.fg('textStrong', s),
    dim: (s) => currentTheme.fg('textDim', s),
    accent: (s) => currentTheme.fg('accent', s),
    gutter: (s) => currentTheme.fg('diffGutter', s),
    errorBold: (s) => currentTheme.boldFg('error', s),
  };
}

function appendWrappedLine(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
  const wrapped = wrapTextWithAnsi(content, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(firstPrefix);
    return;
  }
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`);
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(`${continuationPrefix}${wrapped[i] ?? ''}`);
  }
}

function renderShellDisplayBlock(
  block: Extract<DisplayBlock, { type: 'shell' }>,
  s: BlockStyles,
  width: number,
): string[] {
  const lines: string[] = [];
  if (block.cwd !== undefined && block.cwd.length > 0) {
    lines.push(s.dim(`cwd: ${block.cwd}`));
  }
  if (block.danger !== undefined) {
    lines.push(s.errorBold(`Dangerous: ${block.danger}`));
  }
  const cmdLines = block.command.length > 0 ? block.command.split('\n') : [''];
  cmdLines.forEach((cmdLine, idx) => {
    const prefix = idx === 0 ? `${s.accent('$')} ` : `${s.dim('·')} `;
    appendWrappedLine(lines, prefix, '  ', s.strong(cmdLine), width);
  });
  if (block.description !== undefined && block.description.length > 0) {
    lines.push(`  ${s.dim(block.description)}`);
  }
  return lines;
}

function renderDisplayBlock(
  block: DisplayBlock,
  s: BlockStyles,
  contentWidth: number,
): string[] {
  switch (block.type) {
    case 'diff':
      return renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
        contextLines: 3,
        expandKeyHint: 'ctrl+e to preview',
        maxLines: DIFF_SUMMARY_MAX_LINES,
      });
    case 'file_content': {
      const lang = block.language ?? langFromPath(block.path);
      const allLines = highlightLines(block.content, lang);
      const shown = allLines.slice(0, CONTENT_SUMMARY_MAX_LINES);
      const lines = [s.strong(block.path)];
      for (const [i, line] of shown.entries()) {
        lines.push(s.gutter(String(i + 1).padStart(4) + '  ') + line);
      }
      const remaining = allLines.length - shown.length;
      if (remaining > 0) {
        lines.push(
          s.dim(
            `     … ${String(remaining)} more line${remaining > 1 ? 's' : ''} hidden (ctrl+e to preview)`,
          ),
        );
      }
      return lines;
    }
    case 'shell':
      return renderShellDisplayBlock(block, s, contentWidth);
    case 'file_op': {
      const op = s.accent(block.operation.padEnd(5));
      const lines = [`${op} ${s.strong(block.path)}`];
      if (block.detail !== undefined && block.detail.length > 0) {
        lines.push(s.dim(block.detail));
      }
      return lines;
    }
    case 'url_fetch': {
      const method = s.accent((block.method ?? 'GET').toUpperCase().padEnd(5));
      return [`${method} ${s.strong(block.url)}`];
    }
    case 'search': {
      const lines = [`${s.accent('search')} ${s.strong(block.query)}`];
      if (block.scope !== undefined && block.scope.length > 0) {
        lines.push(s.dim(`scope: ${block.scope}`));
      }
      return lines;
    }
    case 'invocation': {
      const lines = [`${s.accent(block.kind.padEnd(5))} ${s.strong(block.name)}`];
      if (block.description !== undefined && block.description.length > 0) {
        lines.push(s.dim(truncateOneLine(block.description, 200)));
      }
      return lines;
    }
    case 'brief':
      return block.text
        ? block.text.split('\n').map((line) => (line.length > 0 ? s.strong(line) : ''))
        : [];
    case 'background_task':
      return [
        s.strong(`${block.status} ${block.kind} task ${block.task_id}: ${block.description}`),
      ];
    case 'todo':
      return block.items.map((item) => s.strong(`- [${item.status}] ${item.title}`));
    default:
      return [];
  }
}

function normalizeApprovalText(text: string): string {
  return text.replaceAll('\r\n', '\n').trim();
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false;
  const normalizedDescription = normalizeApprovalText(description);
  if (normalizedDescription.length === 0) return false;
  const normalizedBlockText = normalizeApprovalText(block.text);
  if (normalizedBlockText === normalizedDescription) return true;
  const blockLines = normalizedBlockText.split('\n');
  if (blockLines.length <= 1) return false;
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription;
}

function headerFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'Run this command?';
    case 'Write':
      return 'Write this file?';
    case 'Edit':
      return 'Apply these edits?';
    case 'TaskStop':
      return 'Stop this task?';
    case 'ExitPlanMode':
      return 'Ready to build with this plan?';
    default:
      return `Approve ${toolName}?`;
  }
}

export interface ApprovalPanelOptions {
  /** Dock the panel (fullscreen): the request body scrolls past this many rows. */
  readonly layout?: DockLayout;
  /** Whether the terminal window has focus; the panel fades while it does not. */
  readonly isTerminalFocused?: () => boolean;
  /** `Ctrl+N`: hand the keyboard to the Updates panel; false when it has nothing to show. */
  readonly onFocusUpdates?: () => boolean;
}

export class ApprovalPanelComponent extends DockSection implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private feedbackMode = false;
  private readonly feedbackInput = new Input();
  private onResponse: (response: ApprovalPanelResponse) => void;
  private request: PendingApproval;
  private readonly onToggleToolOutput: (() => void) | undefined;
  private readonly onOpenPreview:
    | ((block: DiffDisplayBlock | FileContentDisplayBlock) => void)
    | undefined;
  private readonly isTerminalFocused: () => boolean;
  private readonly onFocusUpdates: (() => boolean) | undefined;
  /** A click this soon after the panel appeared was aimed at what was there before. */
  private readonly shownAt = Date.now();
  /** Foot row of each choice in the last render, for mouse hit-testing. */
  private choiceRows: readonly number[] = [];
  /** Choice under the pointer: highlighted and previewed, but not selected. */
  private hoverIndex: number | undefined;

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalPanelResponse) => void,
    onToggleToolOutput?: () => void,
    onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void,
    options: ApprovalPanelOptions = {},
  ) {
    super(options.layout);
    this.request = request;
    this.onResponse = onResponse;
    this.onToggleToolOutput = onToggleToolOutput;
    this.onOpenPreview = onOpenPreview;
    this.isTerminalFocused = options.isTerminalFocused ?? (() => true);
    this.onFocusUpdates = options.onFocusUpdates;
    this.feedbackInput.onSubmit = (value) => {
      this.submit(this.selectedIndex, value);
    };
    this.feedbackInput.onEscape = () => {
      this.feedbackMode = false;
      this.feedbackInput.setValue('');
    };
  }

  private submit(index: number, feedback: string = ''): void {
    const option = this.choiceAt(index);
    if (!option) return;
    this.onResponse({
      response: option.response,
      feedback: feedback || undefined,
      selected_label: option.selected_label,
    });
  }

  private selectAndSubmit(index: number): void {
    const option = this.choiceAt(index);
    if (!option) return;
    if (option.requires_feedback === true) {
      this.selectedIndex = index;
      this.feedbackMode = true;
    } else {
      this.submit(index);
    }
  }

  handleInput(data: string): void {
    this.hoverIndex = undefined;
    if (matchesKey(normalizeCapsLockedCtrl(data), Key.ctrl('n')) && this.onFocusUpdates?.() === true) {
      return;
    }

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (matchesKey(data, Key.ctrl('e'))) {
      const previewable = this.findPreviewableBlock();
      if (previewable !== undefined && this.onOpenPreview !== undefined) {
        this.onOpenPreview(previewable);
      }
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (matchesKey(data, 'shift+up') || matchesKey(data, 'shift+down')) {
      this.scrollBody(matchesKey(data, 'shift+up') ? -1 : 1);
      return;
    }

    if (this.feedbackMode) {
      if (matchesKey(data, Key.up)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
        return;
      }
      this.feedbackInput.handleInput(data);
      return;
    }

    if (this.choiceCount() === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAndSubmit(this.selectedIndex);
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numericIndex = Number(printable) - 1;
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < this.choiceCount()) {
      this.selectAndSubmit(numericIndex);
    }
  }

  /** Faded while another panel holds the keyboard or the terminal window is inactive. */
  protected renderPart(part: DockPart, width: number): string[] {
    const lines =
      part === 'head'
        ? this.renderHead(width)
        : part === 'body'
          ? this.renderBody(width)
          : this.renderFoot(width);
    return this.focused && this.isTerminalFocused() ? lines : lines.map((line) => currentTheme.fade(line));
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    const index = part === 'foot' ? this.choiceRows.indexOf(event.y) : -1;
    if (event.type === 'move') {
      const hovered = index === -1 || this.feedbackMode || !this.focused ? undefined : index;
      if (hovered === this.hoverIndex) return index === -1 ? undefined : { handled: true };
      this.hoverIndex = hovered;
      return { handled: true, render: true };
    }
    if (event.button !== 'left') return undefined;
    if (event.type === 'click' && !this.focused) return { handled: true, focus: true };
    if (index === -1) return undefined;
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      this.clickChoice(index);
    }
    return { handled: true };
  }

  private clickChoice(index: number): void {
    if (!this.feedbackMode) {
      this.selectAndSubmit(index);
      return;
    }
    this.selectedIndex = index;
    this.feedbackMode = this.choiceAt(index)?.requires_feedback === true;
  }

  private renderHead(width: number): string[] {
    const borderColorBold = (text: string) => currentTheme.boldFg('borderFocus', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const environment = this.request.data.environment;
    const lines = [
      currentTheme.fg(this.focused ? 'borderFocus' : 'border', '─'.repeat(width)),
      `  ${borderColorBold('▶')} ${borderColorBold(headerFor(this.request.data.tool_name))}` +
        (environment === undefined ? '' : `  ${dim(environment)}`),
    ];
    if (this.visibleBlocks().length > 0 || this.request.data.description) lines.push('');
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderBody(width: number): string[] {
    const { data } = this.request;
    const blocks = this.visibleBlocks();
    const lines: string[] = [];
    if (blocks.length > 0) {
      const blockStyles = makeBlockStyles();
      for (const block of blocks) {
        for (const line of renderDisplayBlock(block, blockStyles, Math.max(1, width - 2))) {
          lines.push(`  ${line}`);
        }
      }
    } else if (data.description) {
      for (const descLine of data.description.split('\n')) {
        lines.push(`  ${currentTheme.fg('textDim', descLine)}`);
      }
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The choices and key hints. Inline, a choice's description sits under its
   * label; docked, the selected choice's description fills a fixed area under
   * the list, as tall as the longest one, so moving the selection never moves
   * the rows.
   */
  private renderFoot(width: number): string[] {
    this.ensureValidSelection();
    this.feedbackInput.focused = this.focused && this.feedbackMode;
    const { data } = this.request;
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const strong = (text: string) => currentTheme.fg('textStrong', text);
    const selectColorBold = (text: string) => currentTheme.boldFg('accent', text);
    const indent = (text: string): string => `  ${text}`;
    const docked = this.layout !== undefined;
    const hoverBackground = this.focused && !this.feedbackMode ? currentTheme.hoverBackground() : undefined;
    const hovered = hoverBackground === undefined ? undefined : this.hoverIndex;
    const descriptionRows = (option: ApprovalPanelChoice, rowWidth: number): string[] =>
      option.description === undefined || option.description.length === 0
        ? []
        : wrapTextWithAnsi(option.description, rowWidth);

    const lines: string[] = [''];
    const choiceRows: number[] = [];
    for (const [idx, option] of data.choices.entries()) {
      const isSelected = idx === this.selectedIndex;
      const labelWithNum = `${String(idx + 1)}. ${option.label}`;
      const typingFeedback = this.feedbackMode && option.requires_feedback === true && isSelected;
      choiceRows.push(lines.length);
      const choiceLine = typingFeedback
        ? this.renderInlineFeedbackLine(width - 2, labelWithNum)
        : isSelected
          ? `${selectColorBold('▶')} ${selectColorBold(labelWithNum)}`
          : `  ${strong(labelWithNum)}`;
      const line = indent(choiceLine);
      lines.push(
        idx === hovered && hoverBackground !== undefined
          ? paintHoverRow(line, width, hoverBackground)
          : line,
      );
      if (!docked && !typingFeedback) {
        for (const descLine of descriptionRows(option, Math.max(20, width - 7))) {
          lines.push(indent(`     ${dim(descLine)}`));
        }
      }
    }
    this.choiceRows = choiceRows;

    if (docked) {
      const areaWidth = Math.max(1, width - 2);
      const areaHeight = Math.min(
        DESCRIPTION_AREA_MAX_ROWS,
        Math.max(0, ...data.choices.map((choice) => descriptionRows(choice, areaWidth).length)),
      );
      if (areaHeight > 0) {
        const shown = data.choices[hovered ?? this.selectedIndex];
        const rows = shown === undefined ? [] : descriptionRows(shown, areaWidth);
        lines.push('');
        for (let row = 0; row < areaHeight; row++) {
          const cut = row === areaHeight - 1 && rows.length > areaHeight;
          const text = cut ? `${truncateToWidth(rows[row]!, areaWidth - 1, '')}…` : (rows[row] ?? '');
          lines.push(indent(currentTheme.fg('text', text)));
        }
      }
    }

    lines.push('');
    if (!this.focused) {
      lines.push(indent(dim('esc back to approval')));
    } else if (this.feedbackMode) {
      lines.push(indent(dim('Type feedback · ↵ submit.')));
    } else {
      const expandHint = this.visibleBlocks().some(
        (block) => block.type === 'diff' || block.type === 'file_content',
      )
        ? ' · ctrl+e preview'
        : '';
      const scrollHint = this.bodyOverflows(width) ? ' · shift+↑/↓ scroll' : '';
      lines.push(
        indent(
          dim(
            `↑/↓ select · ${buildNumericHint(data.choices.length)} choose · ↵ confirm${expandHint}${scrollHint}`,
          ),
        ),
      );
    }
    lines.push(currentTheme.fg(this.focused ? 'borderFocus' : 'border', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private visibleBlocks(): DisplayBlock[] {
    const { data } = this.request;
    return data.display
      .filter((block) => !isDuplicateBriefBlock(block, data.description))
      .slice(0, 5);
  }

  private findPreviewableBlock(): DiffDisplayBlock | FileContentDisplayBlock | undefined {
    for (const block of this.request.data.display) {
      if (block.type === 'diff' || block.type === 'file_content') return block;
    }
    return undefined;
  }

  private choiceAt(index: number): ApprovalPanelChoice | undefined {
    return this.request.data.choices[index];
  }

  private choiceCount(): number {
    return this.request.data.choices.length;
  }

  private ensureValidSelection(): void {
    const count = this.choiceCount();
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex < 0 || this.selectedIndex >= count) {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
    }
  }

  private renderInlineFeedbackLine(width: number, labelWithNum: string): string {
    const prefix = `${currentTheme.boldFg('accent', '▶')} ${currentTheme.boldFg('accent', labelWithNum)}  `;
    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.feedbackInput.render(inputWidth)[0] ?? '> ';
    const inlineInput = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
  }

  override invalidate(): void {
    super.invalidate();
    this.feedbackInput.invalidate();
  }
}

function buildNumericHint(count: number): string {
  if (count <= 0) return '↵';
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/');
}
