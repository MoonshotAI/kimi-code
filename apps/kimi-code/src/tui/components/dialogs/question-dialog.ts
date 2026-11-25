import {
  Input,
  matchesKey,
  Key,
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
import type {
  PendingQuestion,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from '#/tui/reverse-rpc/types';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  isPointInRect,
  ListMouseTracker,
  renderInlineSegments,
  SpanHitMap,
  type EmbeddedRect,
  type InlineSegment,
  type InlineTarget,
} from '#/tui/utils/mouse-regions';
import { StableWindow } from '#/tui/utils/paging';
import { printableChar } from '#/tui/utils/printable-key';

const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const MAX_BODY_LINES = 12;
const DEFAULT_OTHER_LABEL = 'Other';
const NOT_ANSWERED_LABEL = 'Not answered';
const REVIEW_TITLE = 'Review your answer before submit';
const SUBMIT_PROMPT = 'Ready to submit your answers?';
const UNANSWERED_WARNING = 'Some questions are still unanswered.';
const SUBMIT_ACTIONS = ['Submit', 'Cancel'] as const;

export interface QuestionDialogOptions {
  readonly layout?: DockLayout;
  readonly isTerminalFocused?: () => boolean;
  readonly onFocusUpdates?: () => boolean;
}

type BodyTarget =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'review-question'; readonly index: number }
  | { readonly kind: 'submit-action'; readonly index: number };

interface DisplayOption {
  readonly label: string;
  readonly description?: string;
  readonly kind: 'preset' | 'other';
}

interface RenderedOtherLine {
  readonly line: string;
  readonly prefixWidth: number;
  readonly inputWidth: number;
}

function appendWrapped(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
  tone?: (s: string) => string,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  const styleLine = tone ?? ((s: string) => s);
  if (wrapped.length === 0) {
    lines.push(styleLine(firstPrefix));
    return;
  }
  lines.push(styleLine(`${firstPrefix}${wrapped[0] ?? ''}`));
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(styleLine(`${continuationPrefix}${wrapped[i] ?? ''}`));
  }
}

export class QuestionDialogComponent extends DockSection implements Focusable {
  focused = false;

  private readonly request: PendingQuestion;
  private readonly onAnswer: (response: QuestionPanelResponse) => void;
  private readonly maxVisibleOptions: number;
  private readonly otherInput = new Input();
  private readonly tabHits = new SpanHitMap<number>();
  private readonly bodyMouse = new ListMouseTracker<BodyTarget>();
  private readonly optionWindows: StableWindow[];

  private currentTab = 0;
  private submitActionIdx = 0;
  private editingOther = false;
  private reviewMessage: string | undefined;
  private lastAnswerMethod: QuestionSubmissionMethod | undefined;
  private otherInputRect: EmbeddedRect | undefined;
  private pendingScrollReveal = false;

  private readonly cursors: number[];
  private readonly singleSelections: (number | undefined)[];
  private readonly multiSelections: Set<number>[];
  private readonly otherDrafts: string[];
  private readonly committedOtherValues: (string | undefined)[];
  private readonly answers: (string | undefined)[];

  private readonly onToggleToolOutput: (() => void) | undefined;
  private readonly isTerminalFocused: () => boolean;
  private readonly onFocusUpdates: (() => boolean) | undefined;

  constructor(
    request: PendingQuestion,
    onAnswer: (response: QuestionPanelResponse) => void,
    maxVisibleOptions = 6,
    onToggleToolOutput?: () => void,
    options: QuestionDialogOptions = {},
  ) {
    super(options.layout);
    this.request = request;
    this.onAnswer = onAnswer;
    this.maxVisibleOptions = maxVisibleOptions;
    this.onToggleToolOutput = onToggleToolOutput;
    this.isTerminalFocused = options.isTerminalFocused ?? (() => true);
    this.onFocusUpdates = options.onFocusUpdates;
    this.otherInput.onSubmit = (value) => {
      this.commitOtherInput(value, 'enter');
    };

    const total = request.data.questions.length;
    this.optionWindows = Array.from({ length: total }, () => new StableWindow());
    this.cursors = Array.from({ length: total }, (): number => 0);
    this.singleSelections = Array.from({ length: total }, (): number | undefined => undefined);
    this.multiSelections = Array.from({ length: total }, () => new Set<number>());
    this.otherDrafts = Array.from({ length: total }, (): string => '');
    this.committedOtherValues = Array.from({ length: total }, (): string | undefined => undefined);
    this.answers = Array.from({ length: total }, (): string | undefined => undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(normalizeCapsLockedCtrl(data), Key.ctrl('n')) && this.onFocusUpdates?.() === true) {
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.isEditingOther()) {
      this.handleOtherInput(data);
      return;
    }

    if (this.isSubmitTab()) {
      this.handleSubmitInput(data);
      return;
    }

    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const optionCount = this.displayOptions(questionIdx).length;
    if (optionCount === 0) return;

    if (matchesKey(data, Key.up)) {
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveQuestionCursor(1);
      return;
    }

    if (this.handleTabNavigationKey(data)) return;

    if (matchesKey(data, Key.enter)) {
      this.activateQuestionOption(this.currentCursor(), 'enter');
      return;
    }

    const printable = printableChar(data);
    const numIdx = NUMBER_KEYS.indexOf(printable);
    if (numIdx >= 0 && numIdx < optionCount) {
      this.cursors[questionIdx] = numIdx;
      this.revealQuestionOption(questionIdx, numIdx);
      this.activateQuestionOption(numIdx, 'number_key');
      return;
    }

    if ((printable === ' ' || matchesKey(data, Key.space)) && question.multi_select) {
      this.activateQuestionOption(this.currentCursor(), 'space');
    }
  }

  private handleOtherInput(data: string): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    if (matchesKey(data, Key.tab)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.gotoTab(this.currentTab + 1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(1);
      return;
    }

    this.otherInput.handleInput(data);
    this.syncOtherDraft(questionIdx);
    this.reviewMessage = undefined;
  }

  private handleSubmitInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.submitActionIdx =
        (this.submitActionIdx - 1 + SUBMIT_ACTIONS.length) % SUBMIT_ACTIONS.length;
      this.reviewMessage = undefined;
      if (this.layout !== undefined) this.pendingScrollReveal = true;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.submitActionIdx = (this.submitActionIdx + 1) % SUBMIT_ACTIONS.length;
      this.reviewMessage = undefined;
      if (this.layout !== undefined) this.pendingScrollReveal = true;
      return;
    }

    if (this.handleTabNavigationKey(data)) return;

    if (matchesKey(data, Key.enter)) {
      this.executeSubmitAction(this.submitActionIdx, 'enter');
      return;
    }

    const printable = printableChar(data);
    if (printable === '1') {
      this.submitActionIdx = 0;
      this.executeSubmitAction(0, 'number_key');
      return;
    }
    if (printable === '2') {
      this.submitActionIdx = 1;
      this.executeSubmitAction(1, 'number_key');
    }
  }

  private handleTabNavigationKey(data: string): boolean {
    if (matchesKey(data, Key.left)) {
      this.gotoTab(this.currentTab - 1);
      return true;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return true;
    }
    return false;
  }

  private enterTab(nextTab: number): void {
    this.currentTab = nextTab;
    this.editingOther = false;
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
    this.scrollBodyToTop();
    if (this.layout !== undefined && !this.isSubmitTab() && this.currentCursor() > 0) {
      this.pendingScrollReveal = true;
    }
  }

  private gotoTab(target: number): void {
    const total = this.totalTabs();
    if (total <= 0) return;

    const wrapped = ((target % total) + total) % total;
    if (wrapped === this.currentTab) return;

    if (this.isEditingOther()) {
      const questionIdx = this.currentQuestionIndex();
      if (questionIdx !== undefined) this.syncOtherDraft(questionIdx);
    }

    this.enterTab(wrapped);
  }

  private moveQuestionCursor(delta: number): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const total = this.displayOptions(questionIdx).length;
    if (total <= 0) return;

    const nextCursor = (this.currentCursor() + delta + total) % total;
    this.cursors[questionIdx] = nextCursor;
    this.reviewMessage = undefined;
    this.revealQuestionOption(questionIdx, nextCursor);
  }

  private revealQuestionOption(questionIdx: number, optionIdx: number): void {
    if (this.layout !== undefined) {
      this.pendingScrollReveal = true;
      return;
    }
    const total = this.displayOptions(questionIdx).length;
    this.optionWindows[questionIdx]?.ensureVisible(optionIdx, total, this.maxVisibleOptions);
  }

  private activateQuestionOption(optionIdx: number, method: QuestionSubmissionMethod): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    this.cursors[questionIdx] = optionIdx;
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (this.isOtherOption(questionIdx, optionIdx)) {
      if (question.multi_select && this.multiSelections[questionIdx]?.has(optionIdx)) {
        this.multiSelections[questionIdx].delete(optionIdx);
        this.lastAnswerMethod = method;
        this.updateAnswer(questionIdx);
        return;
      }
      this.enterOtherInput(questionIdx);
      return;
    }

    if (question.multi_select) {
      const set = this.multiSelections[questionIdx];
      if (set === undefined) return;
      if (set.has(optionIdx)) set.delete(optionIdx);
      else set.add(optionIdx);
      this.lastAnswerMethod = method;
      this.updateAnswer(questionIdx);
      return;
    }

    this.singleSelections[questionIdx] = optionIdx;
    this.committedOtherValues[questionIdx] = undefined;
    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.advanceAfterSingleSelect(questionIdx);
  }

  private enterOtherInput(questionIdx: number): void {
    const otherIdx = this.otherOptionIndex(questionIdx);
    this.cursors[questionIdx] = otherIdx;
    this.editingOther = true;
    this.otherInput.setValue(this.otherDraftValue(questionIdx));
    this.reviewMessage = undefined;
    this.revealQuestionOption(questionIdx, otherIdx);
  }

  private commitOtherInput(rawValue: string | undefined, method: QuestionSubmissionMethod): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const value = (rawValue ?? this.otherInput.getValue()).trim();
    if (value.length === 0) return;

    this.otherInput.setValue(value);
    this.otherDrafts[questionIdx] = value;
    this.committedOtherValues[questionIdx] = value;

    if (question.multi_select) {
      this.multiSelections[questionIdx]?.add(this.otherOptionIndex(questionIdx));
    } else {
      this.singleSelections[questionIdx] = this.otherOptionIndex(questionIdx);
    }

    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (!question.multi_select) this.advanceAfterSingleSelect(questionIdx);
  }

  private advanceAfterSingleSelect(questionIdx: number): void {
    const next = this.findNextUnansweredAfter(questionIdx);
    this.enterTab(next ?? this.submitTabIndex());
  }

  private findNextUnansweredAfter(fromIdx: number): number | null {
    const total = this.request.data.questions.length;
    for (let idx = fromIdx + 1; idx < total; idx++) {
      if (!this.isAnswered(idx)) return idx;
    }
    return null;
  }

  private updateAnswer(questionIdx: number): void {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    if (question.multi_select) {
      const labels: string[] = [];
      const set = this.multiSelections[questionIdx] ?? new Set<number>();
      const otherIdx = this.otherOptionIndex(questionIdx);
      for (let i = 0; i < question.options.length; i++) {
        if (!set.has(i)) continue;
        const label = question.options[i]?.label;
        if (label !== undefined && label.length > 0) labels.push(label);
      }
      const otherText = this.committedOtherValues[questionIdx];
      if (set.has(otherIdx) && otherText !== undefined && otherText.length > 0) {
        labels.push(otherText);
      }
      this.answers[questionIdx] = labels.length > 0 ? labels.join(', ') : undefined;
      return;
    }

    const selection = this.singleSelections[questionIdx];
    if (selection === undefined) {
      this.answers[questionIdx] = undefined;
      return;
    }

    if (this.isOtherOption(questionIdx, selection)) {
      const otherText = this.committedOtherValues[questionIdx];
      this.answers[questionIdx] =
        otherText !== undefined && otherText.length > 0 ? otherText : undefined;
      return;
    }

    const label = question.options[selection]?.label;
    this.answers[questionIdx] = label !== undefined && label.length > 0 ? label : undefined;
  }

  private executeSubmitAction(actionIdx: number, method: QuestionSubmissionMethod): void {
    if (actionIdx === 1) {
      this.onAnswer({ answers: [] });
      return;
    }

    this.reviewMessage = undefined;
    this.emitAnswers(method);
  }

  private emitAnswers(method: QuestionSubmissionMethod): void {
    const out: string[] = [];
    for (let i = 0; i < this.answers.length; i++) {
      const answer = this.answers[i];
      if (answer !== undefined && answer.length > 0) out[i] = answer;
    }
    this.onAnswer({ answers: out, method: this.lastAnswerMethod ?? method });
  }

  protected renderPart(part: DockPart, width: number): string[] {
    this.otherInput.focused = this.focused && this.isEditingOther();
    let lines: string[];
    switch (part) {
      case 'head':
        lines = this.renderHead(width);
        break;
      case 'body':
        lines = this.renderBody(width);
        break;
      case 'foot':
        lines = this.renderFoot(width);
        break;
    }
    if (this.focused && this.isTerminalFocused()) return lines;
    return lines.map((line) => currentTheme.fade(line));
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (part === 'head') {
      if (event.type === 'wheel') return { handled: true };
      if (!this.focused) return focusOnUnfocusedClick(false, event);
      return this.tabHits.handle(event, {
        focused: this.focused,
        onActivate: (tabIndex) => {
          this.gotoTab(tabIndex);
        },
      });
    }
    if (part === 'foot') {
      if (event.type === 'wheel') return { handled: true };
      return focusOnUnfocusedClick(this.focused, event);
    }
    if (event.type === 'wheel') {
      if (this.layout !== undefined) return undefined;
      if (!this.focused) return { handled: true };
      return { handled: true, render: this.scrollRegularOptions(event.wheelDelta ?? 0) };
    }
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (
      this.isEditingOther() &&
      this.otherInputRect !== undefined &&
      isPointInRect(this.otherInputRect, event.x, event.y)
    ) {
      if (event.type === 'press' && event.button === 'left') {
        const forwarded = forwardEmbeddedMouse(this.otherInput, this.otherInputRect, event);
        return forwarded === undefined ? undefined : { ...forwarded, render: true };
      }
      if ((event.type === 'release' || event.type === 'click') && event.button === 'left') {
        return { handled: true };
      }
      return undefined;
    }
    return this.bodyMouse.handle(event, {
      focused: this.focused,
      onHover: this.isEditingOther() ? undefined : (target) => this.hoverBodyTarget(target),
      onActivate: (target) => {
        this.activateBodyTarget(target);
      },
    });
  }

  private hoverBodyTarget(target: BodyTarget): boolean {
    switch (target.kind) {
      case 'option': {
        const questionIdx = this.currentQuestionIndex();
        if (questionIdx === undefined) return false;
        if (this.cursors[questionIdx] === target.index) return false;
        this.cursors[questionIdx] = target.index;
        this.reviewMessage = undefined;
        return true;
      }
      case 'submit-action': {
        if (this.submitActionIdx === target.index) return false;
        this.submitActionIdx = target.index;
        this.reviewMessage = undefined;
        return true;
      }
      case 'review-question':
        return false;
    }
  }

  private activateBodyTarget(target: BodyTarget): void {
    switch (target.kind) {
      case 'option': {
        const questionIdx = this.currentQuestionIndex();
        if (questionIdx === undefined) return;
        if (this.isEditingOther()) {
          if (target.index === this.otherOptionIndex(questionIdx)) return;
          this.syncOtherDraft(questionIdx);
          this.editingOther = false;
        }
        this.activateQuestionOption(target.index, 'enter');
        return;
      }
      case 'review-question':
        this.gotoTab(target.index);
        return;
      case 'submit-action':
        this.submitActionIdx = target.index;
        this.executeSubmitAction(target.index, 'enter');
    }
  }

  private scrollRegularOptions(delta: number): boolean {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return false;
    const total = this.displayOptions(questionIdx).length;
    const window = this.optionWindows[questionIdx];
    if (window === undefined) return false;
    return window.scrollBy(delta, total, this.maxVisibleOptions);
  }

  private rule(width: number): string {
    return currentTheme.fg(this.focused ? 'primary' : 'border', '─'.repeat(width));
  }

  private renderHead(width: number): string[] {
    const renderWidth = Math.max(1, width);
    this.tabHits.reset();
    const tabs = this.renderTabsLine(renderWidth);
    const lines: string[] = [this.rule(renderWidth), currentTheme.boldFg('primary', ' question'), ''];
    const tabRow = lines.length;
    lines.push(tabs.line);
    this.tabHits.addRow(tabRow, tabs.targets);
    lines.push('');

    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) {
      const warning = (text: string) => currentTheme.fg('warning', text);
      lines.push(currentTheme.boldFg('text', ` ${REVIEW_TITLE}`));
      const reviewWarning =
        this.reviewMessage ?? (this.hasUnansweredQuestions() ? UNANSWERED_WARNING : undefined);
      if (reviewWarning !== undefined) {
        lines.push(warning(`  ${reviewWarning}`));
      }
      return lines.map((line) => truncateToWidth(line, width));
    }

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return [];

    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    appendWrapped(lines, ' ? ', '   ', question.question, renderWidth, accent);
    if (this.isEditingOther()) {
      lines.push(dim('   Type your answer, then press Enter to save.'));
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderBody(width: number): string[] {
    this.bodyMouse.reset();
    this.otherInputRect = undefined;
    const lines = this.isSubmitTab()
      ? this.renderSubmitBody(width)
      : this.renderQuestionBody(width);
    if (this.layout !== undefined && this.pendingScrollReveal) {
      this.pendingScrollReveal = false;
      const target: BodyTarget = this.isSubmitTab()
        ? { kind: 'submit-action', index: this.submitActionIdx }
        : { kind: 'option', index: this.currentCursor() };
      const range = this.bodyMouse.rangeOf(target);
      if (range !== undefined) this.scrollBodyIntoView(range.start, range.end, true);
    }
    return lines;
  }

  private renderFoot(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const questionIdx = this.currentQuestionIndex();
    const hint =
      !this.focused
        ? dim('  esc back to question')
        : questionIdx === undefined
          ? this.buildSubmitHint(dim)
          : this.buildQuestionHint(dim, questionIdx);
    return ['', hint, this.rule(renderWidth)].map((line) => truncateToWidth(line, width));
  }

  private renderQuestionBody(width: number): string[] {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return this.renderSubmitBody(width);

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return [];

    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const success = (text: string) => currentTheme.fg('success', text);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];

    if (question.body !== undefined && question.body.trim().length > 0) {
      lines.push('');
      const bodyLines = question.body.trim().split('\n');
      const visibleBodyLines =
        this.layout !== undefined ? bodyLines : bodyLines.slice(0, MAX_BODY_LINES);
      for (const bodyLine of visibleBodyLines) {
        appendWrapped(lines, '   ', '   ', bodyLine, renderWidth, dim);
      }
      if (bodyLines.length > visibleBodyLines.length) {
        lines.push(dim(`   … ${String(bodyLines.length - visibleBodyLines.length)} more lines`));
      }
    }

    lines.push('');

    const options = this.displayOptions(questionIdx);
    const cursor = this.currentCursor();
    let visibleStart = 0;
    let visibleEnd = options.length;
    if (this.layout === undefined) {
      const range = this.optionWindows[questionIdx]!.range(options.length, this.maxVisibleOptions);
      visibleStart = range.start;
      visibleEnd = range.end;
    }
    const multiSet = this.multiSelections[questionIdx] ?? new Set<number>();
    const singleSelection = this.singleSelections[questionIdx];

    for (let i = visibleStart; i < visibleEnd; i++) {
      const option = options[i];
      if (option === undefined) continue;
      this.bodyMouse.track(lines, { kind: 'option', index: i }, () => {
        const num = i + 1;
        const isCursor = i === cursor;
        const isOther = option.kind === 'other';
        const isSelected = question.multi_select ? multiSet.has(i) : singleSelection === i;

        if (this.isEditingOther() && isCursor && isOther) {
          const rowY = lines.length;
          const rendered = this.renderEditingOtherLine(
            renderWidth,
            questionIdx,
            option,
            num,
            isSelected,
          );
          lines.push(rendered.line);
          this.otherInputRect =
            rendered.inputWidth > 0
              ? {
                  x: rendered.prefixWidth,
                  y: rowY,
                  width: rendered.inputWidth,
                  height: 1,
                  contentOffsetX: 2,
                }
              : undefined;
          return;
        }

        const label = this.renderOptionLabel(questionIdx, option, isCursor);

        let tone: (s: string) => string;
        let prefix: string;
        if (question.multi_select) {
          const checked = isSelected ? '✓' : ' ';
          prefix = `  [${checked}] `;
          if (isSelected && isCursor) tone = (s) => currentTheme.boldFg('success', s);
          else if (isSelected) tone = success;
          else if (isCursor) tone = accent;
          else tone = dim;
        } else if (isSelected && this.isAnswered(questionIdx)) {
          prefix = isCursor ? `  → [${String(num)}] ` : `    [${String(num)}] `;
          tone = isCursor ? (s) => currentTheme.boldFg('success', s) : success;
        } else if (isCursor) {
          prefix = `  → [${String(num)}] `;
          tone = accent;
        } else {
          prefix = `    [${String(num)}] `;
          tone = dim;
        }
        const continuation = ' '.repeat(visibleWidth(prefix));
        appendWrapped(lines, prefix, continuation, label, renderWidth, tone);

        if (
          option.description !== undefined &&
          option.description.length > 0 &&
          !(this.isEditingOther() && isCursor && isOther)
        ) {
          appendWrapped(lines, '        ', '        ', option.description, renderWidth, dim);
        }
      });
    }

    if (this.layout === undefined && (visibleEnd < options.length || visibleStart > 0)) {
      lines.push(
        dim(
          `   showing ${String(visibleStart + 1)}-${String(visibleEnd)} of ${String(options.length)}`,
        ),
      );
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderSubmitBody(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const text = (t: string) => currentTheme.fg('text', t);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [''];

    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      const answer = this.answers[i];
      this.bodyMouse.track(lines, { kind: 'review-question', index: i }, () => {
        appendWrapped(lines, `  ${dim('Q')}  `, '       ', question.question, renderWidth);
        if (answer !== undefined && answer.length > 0) {
          appendWrapped(lines, `  ${accent('→')}  `, '       ', text(answer), renderWidth);
        } else {
          lines.push(`  ${dim('→')}  ${dim(NOT_ANSWERED_LABEL)}`);
        }
      });
    }

    lines.push('');
    lines.push(text(` ${SUBMIT_PROMPT}`));
    lines.push('');

    for (let i = 0; i < SUBMIT_ACTIONS.length; i++) {
      const label = SUBMIT_ACTIONS[i];
      if (label === undefined) continue;
      this.bodyMouse.track(lines, { kind: 'submit-action', index: i }, () => {
        const num = i + 1;
        if (i === this.submitActionIdx) {
          lines.push(accent(`  → [${String(num)}] ${label}`));
        } else {
          lines.push(dim(`    [${String(num)}] ${label}`));
        }
      });
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderTabsLine(width: number): {
    readonly line: string;
    readonly targets: readonly InlineTarget<number>[];
  } {
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const active = (text: string) =>
      currentTheme.bg('primary', currentTheme.boldFg('text', text));

    const segments: InlineSegment<number>[] = [{ text: ' ' }];
    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      if (segments.length > 1) segments.push({ text: '  ' });
      const label =
        question.header !== undefined && question.header.length > 0
          ? question.header
          : `Q${String(i + 1)}`;
      const styled =
        i === this.currentTab
          ? active(` ${label} `)
          : this.isAnswered(i)
            ? currentTheme.fg('success', `(✓) ${label}`)
            : dim(`(○) ${label}`);
      segments.push({ text: styled, value: i });
    }

    if (segments.length > 1) segments.push({ text: '  ' });
    const submitLabel = 'Submit';
    segments.push({
      text: this.isSubmitTab() ? active(` ${submitLabel} `) : dim(` ${submitLabel} `),
      value: this.submitTabIndex(),
    });

    return renderInlineSegments(segments, width);
  }

  private buildQuestionHint(dim: (s: string) => string, questionIdx: number): string {
    if (this.isEditingOther()) {
      const parts: string[] = [
        'type answer',
        '↵ save',
        ...(this.totalTabs() > 1 ? ['tab switch'] : []),
        'esc cancel',
      ];
      return dim(`  ${parts.join('  ')}`);
    }

    const optionCount = Math.min(this.displayOptions(questionIdx).length, NUMBER_KEYS.length);
    const numberHint = optionCount <= 1 ? '1' : `1-${String(optionCount)}`;
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return dim('  esc cancel');

    const parts: string[] = [
      '↑↓ select',
      `${numberHint} / ↵ ${question.multi_select ? 'toggle' : 'choose'}`,
    ];
    if (this.totalTabs() > 1) parts.push('←/→/tab switch');
    parts.push('esc cancel');
    return dim(`  ${parts.join('  ')}`);
  }

  private buildSubmitHint(dim: (s: string) => string): string {
    const parts: string[] = ['↑↓ select', '1/2 choose', '↵ confirm'];
    if (this.totalTabs() > 1) parts.push('←/→/tab switch');
    parts.push('esc cancel');
    return dim(`  ${parts.join('  ')}`);
  }

  private totalTabs(): number {
    return this.request.data.questions.length + 1;
  }

  private submitTabIndex(): number {
    return this.request.data.questions.length;
  }

  private isSubmitTab(): boolean {
    return this.currentTab === this.submitTabIndex();
  }

  private isEditingOther(): boolean {
    return this.editingOther && !this.isSubmitTab();
  }

  private currentQuestionIndex(): number | undefined {
    return this.isSubmitTab() ? undefined : this.currentTab;
  }

  private currentCursor(): number {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return 0;
    return this.cursors[questionIdx] ?? 0;
  }

  private displayOptions(questionIdx: number): DisplayOption[] {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return [];

    return [
      ...question.options.map((option) => ({
        label: option.label,
        description: option.description,
        kind: 'preset' as const,
      })),
      {
        label: question.other_label?.length ? question.other_label : DEFAULT_OTHER_LABEL,
        description: question.other_description?.length ? question.other_description : undefined,
        kind: 'other' as const,
      },
    ];
  }

  private otherOptionIndex(questionIdx: number): number {
    return this.request.data.questions[questionIdx]?.options.length ?? 0;
  }

  private isOtherOption(questionIdx: number, optionIdx: number): boolean {
    return optionIdx === this.otherOptionIndex(questionIdx);
  }

  private renderOptionLabel(questionIdx: number, option: DisplayOption, isCursor: boolean): string {
    if (option.kind !== 'other') return option.label;

    const value = this.otherDraftValue(questionIdx);
    if (this.isEditingOther() && isCursor) {
      return `${option.label}: ${value ?? ''}█`;
    }
    if (value !== undefined && value.length > 0) return `${option.label}: ${value}`;
    return option.label;
  }

  private renderEditingOtherLine(
    width: number,
    questionIdx: number,
    option: DisplayOption,
    num: number,
    isSelected: boolean,
  ): RenderedOtherLine {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return { line: option.label, prefixWidth: 0, inputWidth: 0 };

    let prefix: string;
    if (question.multi_select) {
      const checked = isSelected ? '✓' : ' ';
      const body = `  [${checked}] ${option.label}: `;
      prefix = isSelected
        ? currentTheme.boldFg('success', body)
        : currentTheme.fg('primary', body);
    } else {
      const body = `  → [${String(num)}] ${option.label}: `;
      prefix =
        isSelected && this.isAnswered(questionIdx)
          ? currentTheme.boldFg('success', body)
          : currentTheme.fg('primary', body);
    }

    const prefixWidth = visibleWidth(prefix);
    const visibleInputWidth = Math.max(0, width - prefixWidth);
    const inputWidth = Math.max(4, visibleInputWidth + 2);
    const inputLine = this.otherInput.render(inputWidth)[0] ?? '> ';
    const inlineInput = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
    return {
      line: prefix + inlineInput,
      prefixWidth,
      inputWidth: visibleInputWidth,
    };
  }

  private otherDraftValue(questionIdx: number): string {
    return (this.otherDrafts[questionIdx] ?? this.committedOtherValues[questionIdx]) ?? '';
  }

  private syncOtherDraft(questionIdx: number): void {
    this.otherDrafts[questionIdx] = this.otherInput.getValue();
  }

  private isAnswered(questionIdx: number): boolean {
    const answer = this.answers[questionIdx];
    return answer !== undefined && answer.length > 0;
  }

  private hasUnansweredQuestions(): boolean {
    for (let i = 0; i < this.request.data.questions.length; i++) {
      if (!this.isAnswered(i)) return true;
    }
    return false;
  }

  override invalidate(): void {
    super.invalidate();
    this.otherInput.invalidate();
  }
}
