/**
 * QuestionDialog — pi-tui version of the structured question prompt.
 *
 * Each question collects an answer locally, and a final Submit tab
 * reviews everything before the answers are emitted upstream.
 */

import {
  Container,
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type {
  PendingQuestion,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from '#/tui/reverse-rpc/types';

const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const MAX_BODY_LINES = 12;
const DEFAULT_OTHER_LABEL = 'Other';
const NOT_ANSWERED_LABEL = 'Not answered';
const REVIEW_TITLE = 'Review your answer before submit';
const SUBMIT_PROMPT = 'Ready to submit your answers?';
const UNANSWERED_WARNING = 'Some questions are still unanswered.';
const SUBMIT_ACTIONS = ['Submit', 'Cancel'] as const;

interface DisplayOption {
  readonly label: string;
  readonly description?: string | undefined;
  readonly kind: 'preset' | 'other';
}

/**
 * Push `content` to `lines`, wrapping it to fit `width` with a hanging
 * indent. The first physical line starts with `firstPrefix`; continuation
 * lines get `continuationPrefix`. Pass `tone` to wrap every emitted line
 * in a single ANSI span (cleaner for selection highlights and matches the
 * pre-wrap rendering tests expect); leave it undefined when the prefixes
 * already carry their own mixed styling.
 */
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

export class QuestionDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly request: PendingQuestion;
  private readonly onAnswer: (response: QuestionPanelResponse) => void;
  private readonly maxVisibleOptions: number;
  private readonly otherInput = new Input();

  private currentTab = 0;
  private submitActionIdx = 0;
  private editingOther = false;
  private reviewMessage: string | undefined;
  private lastAnswerMethod: QuestionSubmissionMethod | undefined;

  /** Per-question cursor position. */
  private readonly cursors: number[];
  /** Per-question single-select choice. */
  private readonly singleSelections: (number | undefined)[];
  /** Per-question multi-select choices. */
  private readonly multiSelections: Set<number>[];
  /** Per-question free-text drafts for the synthetic Other option. */
  private readonly otherDrafts: string[];
  /** Per-question committed Other values. */
  private readonly committedOtherValues: (string | undefined)[];
  /** Per-question derived answers used by tabs + review. */
  private readonly answers: (string | undefined)[];

  private readonly onToggleToolOutput: (() => void) | undefined;

  constructor(
    request: PendingQuestion,
    onAnswer: (response: QuestionPanelResponse) => void,
    maxVisibleOptions = 6,
    onToggleToolOutput?: () => void,
  ) {
    super();
    this.request = request;
    this.onAnswer = onAnswer;
    this.maxVisibleOptions = maxVisibleOptions;
    this.onToggleToolOutput = onToggleToolOutput;
    this.otherInput.onSubmit = (value) => {
      this.commitOtherInput(value, 'enter');
    };

    const total = request.data.questions.length;
    this.cursors = Array.from({ length: total }, (): number => 0);
    this.singleSelections = Array.from({ length: total }, (): number | undefined => undefined);
    this.multiSelections = Array.from({ length: total }, () => new Set<number>());
    this.otherDrafts = Array.from({ length: total }, (): string => '');
    this.committedOtherValues = Array.from({ length: total }, (): string | undefined => undefined);
    this.answers = Array.from({ length: total }, (): string | undefined => undefined);
  }

  // ── Input ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
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

    if (matchesKey(data, Key.left)) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.activateQuestionOption(this.currentCursor(), 'enter');
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numIdx = NUMBER_KEYS.indexOf(printable);
    if (numIdx >= 0 && numIdx < optionCount) {
      this.cursors[questionIdx] = numIdx;
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
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.submitActionIdx = (this.submitActionIdx + 1) % SUBMIT_ACTIONS.length;
      this.reviewMessage = undefined;
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.executeSubmitAction(this.submitActionIdx, 'enter');
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
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

  // ── State mutation ────────────────────────────────────────────────

  private gotoTab(target: number): void {
    const total = this.totalTabs();
    if (total <= 0) return;

    const wrapped = ((target % total) + total) % total;
    if (wrapped === this.currentTab) return;

    this.currentTab = wrapped;
    this.editingOther = false;
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
  }

  private moveQuestionCursor(delta: number): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const total = this.displayOptions(questionIdx).length;
    if (total <= 0) return;

    this.cursors[questionIdx] = (this.currentCursor() + delta + total) % total;
    this.reviewMessage = undefined;
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
    this.cursors[questionIdx] = this.otherOptionIndex(questionIdx);
    this.editingOther = true;
    this.otherInput.setValue(this.otherDraftValue(questionIdx));
    this.reviewMessage = undefined;
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
    this.currentTab = next ?? this.submitTabIndex();
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
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

  // ── Render ────────────────────────────────────────────────────────

  override render(width: number): string[] {
    this.otherInput.focused = this.focused && this.isEditingOther();
    return this.isSubmitTab() ? this.renderSubmitTab(width) : this.renderQuestionTab(width);
  }

  private renderQuestionTab(width: number): string[] {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return this.renderSubmitTab(width);

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return [];

    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const success = (text: string) => currentTheme.fg('success', text);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [accent('─'.repeat(renderWidth)), currentTheme.boldFg('primary', ' question'), ''];
    this.pushTabs(lines);
    lines.push('');

    appendWrapped(lines, ' ? ', '   ', question.question, renderWidth, accent);
    if (this.isEditingOther()) {
      lines.push(dim('   Type your answer, then press Enter to save.'));
    }

    if (question.body !== undefined && question.body.trim().length > 0) {
      lines.push('');
      const bodyLines = question.body.trim().split('\n');
      const visibleBodyLines = bodyLines.slice(0, MAX_BODY_LINES);
      for (const bodyLine of visibleBodyLines) {
        appendWrapped(lines, '   ', '   ', bodyLine, renderWidth, dim);
      }
      if (bodyLines.length > visibleBodyLines.length) {
        lines.push(dim(`   ... ${String(bodyLines.length - visibleBodyLines.length)} more lines`));
      }
    }

    lines.push('');

    const options = this.displayOptions(questionIdx);
    const cursor = this.currentCursor();
    const visibleStart = this.computeVisibleStart(cursor, options.length);
    const visibleEnd = Math.min(options.length, visibleStart + this.maxVisibleOptions);
    const multiSet = this.multiSelections[questionIdx] ?? new Set<number>();
    const singleSelection = this.singleSelections[questionIdx];

    for (let i = visibleStart; i < visibleEnd; i++) {
      const option = options[i];
      if (option === undefined) continue;
      const num = i + 1;
      const isCursor = i === cursor;
      const isOther = option.kind === 'other';
      const isSelected = question.multi_select ? multiSet.has(i) : singleSelection === i;

      if (this.isEditingOther() && isCursor && isOther) {
        lines.push(this.renderEditingOtherLine(renderWidth, questionIdx, option, num, isSelected));
        continue;
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
    }

    if (visibleEnd < options.length || visibleStart > 0) {
      lines.push(
        dim(
          `   showing ${String(visibleStart + 1)}-${String(visibleEnd)} of ${String(options.length)}`,
        ),
      );
    }

    lines.push('');
    lines.push(this.buildQuestionHint(dim, questionIdx));
    lines.push(accent('─'.repeat(renderWidth)));

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderSubmitTab(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const text = (t: string) => currentTheme.fg('text', t);
    const warning = (text: string) => currentTheme.fg('warning', text);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [accent('─'.repeat(renderWidth)), currentTheme.boldFg('primary', ' question'), ''];
    this.pushTabs(lines);
    lines.push('');
    lines.push(currentTheme.boldFg('text', ` ${REVIEW_TITLE}`));
    const reviewWarning =
      this.reviewMessage ?? (this.hasUnansweredQuestions() ? UNANSWERED_WARNING : undefined);
    if (reviewWarning !== undefined) {
      lines.push(warning(`  ${reviewWarning}`));
    }
    lines.push('');

    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      const answer = this.answers[i];
      appendWrapped(
        lines,
        `  ${dim('Q')}  `,
        '       ',
        question.question,
        renderWidth,
      );
      if (answer !== undefined && answer.length > 0) {
        appendWrapped(
          lines,
          `  ${accent('→')}  `,
          '       ',
          text(answer),
          renderWidth,
        );
      } else {
        lines.push(`  ${dim('→')}  ${dim(NOT_ANSWERED_LABEL)}`);
      }
    }

    lines.push('');
    lines.push(text(` ${SUBMIT_PROMPT}`));
    lines.push('');

    for (let i = 0; i < SUBMIT_ACTIONS.length; i++) {
      const label = SUBMIT_ACTIONS[i];
      if (label === undefined) continue;
      const num = i + 1;
      if (i === this.submitActionIdx) {
        lines.push(accent(`  → [${String(num)}] ${label}`));
      } else {
        lines.push(dim(`    [${String(num)}] ${label}`));
      }
    }

    lines.push('');
    lines.push(this.buildSubmitHint(dim));
    lines.push(accent('─'.repeat(renderWidth)));

    return lines.map((line) => truncateToWidth(line, width));
  }

  private pushTabs(lines: string[]): void {
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const active = (text: string) =>
      currentTheme.bg('primary', currentTheme.boldFg('text', text));

    const tabs: string[] = [];
    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      const label =
        question.header !== undefined && question.header.length > 0
          ? question.header
          : `Q${String(i + 1)}`;
      if (i === this.currentTab) tabs.push(active(` ${label} `));
      else if (this.isAnswered(i)) tabs.push(currentTheme.fg('success', `(✓) ${label}`));
      else tabs.push(dim(`(○) ${label}`));
    }

    const submitLabel = 'Submit';
    if (this.isSubmitTab()) tabs.push(active(` ${submitLabel} `));
    else tabs.push(dim(` ${submitLabel} `));

    lines.push(` ${tabs.join('  ')}`);
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

  private computeVisibleStart(cursor: number, total: number): number {
    if (total <= this.maxVisibleOptions) return 0;
    const half = Math.floor(this.maxVisibleOptions / 2);
    const max = Math.max(0, total - this.maxVisibleOptions);
    return Math.max(0, Math.min(cursor - half, max));
  }

  // ── Helpers ───────────────────────────────────────────────────────

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
  ): string {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return option.label;

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

    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.otherInput.render(inputWidth)[0] ?? '> ';
    const inlineInput = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
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
