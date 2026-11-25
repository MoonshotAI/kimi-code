import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import {
  killProcessTree,
  kimiCliCommand,
  kimiCliEnv,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  readNetworkViolations,
  TIMEOUTS,
  until,
} from '@moonshot-ai/testkit/fixtures';
import { FAKE_PROVIDER_DEFAULTS } from '@moonshot-ai/testkit/model';

import {
  APPROVAL_PENDING,
  describeApproval,
  describeTool,
  namesFile,
  PERMISSION_MODE_NAMES,
  QUESTION_PENDING,
  wantedOutput,
  type ApprovalExpectation,
  type ApprovalToolName,
  type ApproveOptions,
  type Diagnostic,
  type Frame,
  type PermissionMode,
  type ReopenState,
  type SurfaceDriver,
  type SurfaceLaunch,
  type ToolExpectation,
  type ToolStatus,
} from '../support/verbs';
import { offlineStubs } from './offline';

const COLUMNS = 120;
const ROWS = 40;
const SCROLLBACK_LINES = 1000;
const OUTPUT_TAIL = 64 * 1024;
const RECENT_INPUTS = 12;

const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';
const TERMINAL_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g;
const RESTORED_MODES = ['icanon', 'echo'] as const;

const KEYS = {
  enter: '\r',
  escape: '\x1b',
  interrupt: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  approveOnce: '1',
  approveForSession: '2',
  reject: '3',
  rejectWithFeedback: '4',
  toggleDetails: '\x0f',
  queue: '\x11',
  steer: '\x13',
} as const;

const USER_MARK = '❯';
const DONE_MARK = '●';
const FAILED_MARK = '✗';
const TRANSCRIPT_MARKS = [USER_MARK, DONE_MARK, FAILED_MARK] as const;
const ENTRY_INDENT = ' ';

const APPROVAL_HINT = '↵ confirm';
const APPROVAL_RULE = /^─+$/;
const EDITOR_TOP = /^╭─+╮$/;
const EDITOR_PROMPT = '│ >';
const ACTIVITY = /^[\u{1F311}-\u{1F318}\u2800-\u28FF]/u;
const READ_GROUP = /^Read(?:ing)? \d+ files?…?(?: · .*)?$/;
const TOOL_CARD =
  /^(?:(?:Used|Using|Truncated) [A-Za-z][\w.-]*(?: \(.*\))?|Ran a command|Running a command|Read(?:ing)? \d+ files?…?|Collected your answers|Waiting for your input|Could not collect your input|Start(?:ed|ing) background question)(?: · .*)?$/;
const READ_GROUP_FILE = /^[├└]─ (.+?)(?: · (.+))?$/;
const READ_GROUP_PENDING = 'reading…';
const READ_GROUP_FAILED = 'failed';
const TURN_COMPLETED = 'Worked for ';
const TURN_STOPPED = 'Interrupted by user';
const TURN_FAILED = 'Error: [';
const FAILURE_CODE_END = '] ';
const FAILURE_HINT = 'If this persists, run `/export-debug-zip`';
const APPROVED = 'Approved: ';
const APPROVED_FOR_SESSION = 'Approved for session: ';
const REJECTED = 'Rejected: ';
const FEEDBACK_HINT = 'Type feedback · ↵ submit.';
const FEEDBACK_CHOICE = '4. Reject with feedback';
const APPROVAL_TITLE = '▶ ';
const APPROVAL_HEADERS: Readonly<Record<string, ApprovalToolName>> = { 'Run this command?': 'Bash', 'Apply these edits?': 'Edit', 'Write this file?': 'Write' };
const COMMAND_PROMPT = '$ ';
const PERMISSION_COMMAND = '/permission';
const PERMISSION_PICKER = 'Select permission mode';
const PERMISSION_PICKER_ITEM = /^(❯ )?(.+?)( ← current)?$/;
const PERMISSION_SET = 'Permission mode: ';
const PERMISSION_NOTICES = ['Permission mode', 'Failed to set permission mode'] as const;
const REJECTION_NOTICE = 'was not run because the user rejected the approval request';
const UNFINISHED_TOOL = /^(?:Running a command|Using [A-Za-z])/;
const TRANSCRIPT_NOTES = [APPROVED, APPROVED_FOR_SESSION, REJECTED, TURN_STOPPED, TURN_FAILED, PERMISSION_SET] as const;
const EARLIER_LINES_HIDDEN = '… ';
const QUEUED_ITEM = `${USER_MARK} `;
const CUT_SHORT = '…';
const QUESTION_TITLE = 'question';
const QUESTION_TAB_GAP = /\s{2,}/;
const QUESTION_OPTION = /^(?:→ )?\[(\d+)\] (.*)$/;
const QUESTION_FOCUSED = 'esc cancel';
const QUESTION_SEVERAL_CHOICES = '↵ toggle';
const QUESTION_TYPING = 'type answer';
const QUESTION_REVIEW = 'Ready to submit your answers?';
const QUESTION_SUBMIT = '→ [1] Submit';
const QUESTION_SCROLLS = /^showing \d+-\d+ of \d+$/;
const ASKED = 'Collected your answers';
const ASKED_QUESTION = 'Q';
const ASKED_ANSWER = '→';
const DISMISSED_NOTE = 'User dismissed the question without answering.';

interface Screen {
  readonly text: string;
  readonly height: number;
  readonly viewport: readonly string[];
  readonly input: 'editor' | 'approval' | 'question' | 'none';
  readonly transcript: readonly string[];
  readonly status: readonly string[];
  readonly panel: readonly string[];
}

interface ApprovalPanel {
  readonly title: string;
  readonly tool: ApprovalToolName | undefined;
  readonly rows: readonly string[];
}

interface QuestionOption {
  readonly key: string;
  readonly label: string;
}

interface QuestionDialog {
  readonly questions: number;
  readonly focused: boolean;
  readonly singleChoice: boolean;
  readonly typing: boolean;
  readonly review: boolean;
  readonly scrolls: boolean;
  readonly options: readonly QuestionOption[];
  readonly rows: readonly string[];
}

interface PendingQuestion {
  readonly dialog: QuestionDialog;
  readonly screen: Screen;
}

interface PermissionPicker {
  readonly names: readonly string[];
  readonly cursor: string | undefined;
  readonly current: string | undefined;
}

interface Block {
  readonly mark: (typeof TRANSCRIPT_MARKS)[number];
  readonly head: string;
  readonly text: string;
}

interface GroupedRead {
  readonly path: string;
  readonly status: ToolStatus | undefined;
}

interface Turn {
  readonly stopped: number;
  readonly failed: number;
}

type Settled<T> = { readonly found: T } | { readonly over: Screen };

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function insidePseudoTerminal(launcher: string): string {
  return process.platform === 'darwin'
    ? `script -q /dev/null /bin/sh ${quote(launcher)}`
    : `script -q -e -c ${quote(`/bin/sh ${quote(launcher)}`)} /dev/null`;
}

function unfinishedBeginning(text: string): number {
  for (let length = Math.min(BEGIN_FRAME.length - 1, text.length); length > 0; length -= 1) {
    if (BEGIN_FRAME.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function paste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

function squash(text: string): string {
  return text.replaceAll(/\s+/g, '');
}

function screenOf(rows: readonly string[], viewport: readonly string[]): Screen {
  const lines = rows.map((row) => row.trim());
  const frame = { text: rows.join('\n'), height: rows.length, viewport };
  const editor = lines.findLastIndex((line, index) => EDITOR_TOP.test(line) && lines[index + 1]?.startsWith(EDITOR_PROMPT) === true);
  const hint = lines.findLastIndex((line) => line.includes(APPROVAL_HINT));
  const rule = lines.findLastIndex((line, index) => index < hint && APPROVAL_RULE.test(line));
  const question = lines.findLastIndex((line, index) => APPROVAL_RULE.test(line) && lines[index + 1] === QUESTION_TITLE);
  if (question > editor && question >= rule) {
    const end = lines.findIndex((line, index) => index > question + 1 && APPROVAL_RULE.test(line));
    return { ...frame, input: 'question', transcript: rows.slice(0, question), status: [], panel: rows.slice(question + 2, end < 0 ? undefined : end) };
  }
  if (hint > editor) {
    return { ...frame, input: 'approval', transcript: rows.slice(0, rule < 0 ? hint : rule), status: [], panel: rule < 0 ? [] : rows.slice(rule + 1, hint) };
  }
  if (editor < 0) return { ...frame, input: 'none', transcript: rows, status: [], panel: [] };
  const gap = lines.findLastIndex((line, index) => index < editor && line === '');
  return { ...frame, input: 'editor', transcript: rows.slice(0, gap + 1), status: lines.slice(gap + 1, editor), panel: [] };
}

function failureNoticeEnd(rows: readonly string[], start: number): number | undefined {
  if (!(rows[start] ?? '').trimStart().startsWith(TURN_FAILED)) return undefined;
  for (let index = start + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? '';
    const line = row.trim();
    if (line.startsWith(FAILURE_HINT)) return index;
    if (line === '' || line.startsWith(TURN_FAILED) || startsEntry(row)) return undefined;
  }
  return undefined;
}

function blocksOf(screen: Screen): Block[] {
  const blocks: { mark: Block['mark']; head: string; text: string }[] = [];
  let open: (typeof blocks)[number] | undefined;
  let notice: number | undefined;
  for (const [index, row] of screen.transcript.entries()) {
    const mark = TRANSCRIPT_MARKS.find((candidate) => row.startsWith(`${ENTRY_INDENT}${candidate} `));
    const line = row.trim();
    notice = notice !== undefined && index <= notice ? notice : failureNoticeEnd(screen.transcript, index);
    if (notice !== undefined) {
      open = undefined;
    } else if (mark !== undefined) {
      const head = line.slice(mark.length).trim();
      open = { mark, head, text: head };
      blocks.push(open);
    } else if (line !== '' && open !== undefined) {
      open.text = `${open.text}\n${line}`;
    }
  }
  return blocks;
}

function statusLines(screen: Screen, prefix: string): number {
  return screen.transcript.filter((row) => row.trimStart().startsWith(prefix)).length;
}

function latestTurn(screen: Screen): Block[] {
  const blocks = blocksOf(screen);
  return blocks.slice(blocks.findLastIndex((block) => block.mark === USER_MARK) + 1);
}

function startsEntry(row: string): boolean {
  return TRANSCRIPT_MARKS.some((mark) => row.startsWith(`${ENTRY_INDENT}${mark} `));
}

function rowsAfterLatestUserMessage(screen: Screen): readonly string[] {
  return screen.transcript.slice(screen.transcript.findLastIndex((row) => row.startsWith(`${ENTRY_INDENT}${USER_MARK} `)) + 1);
}

function failuresOf(screen: Screen): string[] {
  const rows = rowsAfterLatestUserMessage(screen);
  return rows.flatMap((row, index) => {
    if (!row.trimStart().startsWith(TURN_FAILED)) return [];
    const lines = [row.trim()];
    for (const next of rows.slice(index + 1)) {
      const line = next.trim();
      if (line.startsWith(FAILURE_HINT)) {
        const failure = lines.join(' ');
        const code = failure.indexOf(FAILURE_CODE_END);
        return code < 0 ? [] : [failure.slice(code + FAILURE_CODE_END.length)];
      }
      if (line === '' || line.startsWith(TURN_FAILED) || startsEntry(next)) return [];
      lines.push(line);
    }
    return [];
  });
}

function userMessages(screen: Screen, text: string): number {
  return blocksOf(screen).filter((block) => block.mark === USER_MARK && squash(block.text).startsWith(squash(text))).length;
}

function showsApproval(screen: Screen): boolean {
  return screen.input === 'approval';
}

function showsQuestion(screen: Screen): boolean {
  return screen.input === 'question';
}

function questionDialog(screen: Screen): QuestionDialog | undefined {
  if (!showsQuestion(screen)) return undefined;
  const rows = screen.panel.map((row) => row.trim()).filter((row) => row !== '');
  const tabs = (rows[0] ?? '').split(QUESTION_TAB_GAP).filter((tab) => tab !== '');
  const hint = rows.at(-1) ?? '';
  const review = rows.includes(QUESTION_REVIEW);
  const options = review
    ? []
    : rows.flatMap((row) => {
        const option = QUESTION_OPTION.exec(row);
        return option?.[1] === undefined || option[2] === undefined ? [] : [{ key: option[1], label: option[2] }];
      });
  return {
    questions: tabs.length - 1,
    focused: hint.endsWith(QUESTION_FOCUSED),
    singleChoice: !hint.includes(QUESTION_SEVERAL_CHOICES),
    typing: hint.startsWith(QUESTION_TYPING),
    review,
    scrolls: rows.some((row) => QUESTION_SCROLLS.test(row)),
    options,
    rows,
  };
}

function reviewShows(dialog: QuestionDialog | undefined, answer: string): boolean {
  return (
    dialog?.review === true &&
    dialog.rows.includes(QUESTION_SUBMIT) &&
    dialog.rows.some((row) => squash(row) === squash(`${ASKED_ANSWER}${answer}`))
  );
}

function askedBlocks(screen: Screen): Block[] {
  return latestTurn(screen).filter((block) => block.mark === DONE_MARK && block.head === ASKED);
}

function collectedAnswers(screen: Screen, answer: string): number {
  return askedBlocks(screen).filter((block) => block.text.split('\n').some((line) => squash(line) === squash(`${ASKED_ANSWER}${answer}`))).length;
}

function dismissedQuestions(screen: Screen): number {
  return askedBlocks(screen).filter((block) => block.text.split('\n').includes(DISMISSED_NOTE)).length;
}

function asksQuestion(block: Block, question: string): boolean {
  return squash(block.text).includes(squash(`${ASKED_QUESTION}${question}${ASKED_ANSWER}`));
}

function indentOf(row: string): number {
  return row.length - row.trimStart().length;
}

function approvalPanel(screen: Screen): ApprovalPanel | undefined {
  const rows = screen.panel.map((row) => row.trimEnd());
  const head = rows.find((row) => row.trim() !== '')?.trim();
  if (head?.startsWith(APPROVAL_TITLE) !== true) return undefined;
  const title = head.slice(APPROVAL_TITLE.length).trim();
  const header = Object.keys(APPROVAL_HEADERS).find((candidate) => title === candidate || title.startsWith(`${candidate} `));
  return { title, tool: header === undefined ? undefined : APPROVAL_HEADERS[header], rows };
}

function panelCommand(panel: ApprovalPanel): string | undefined {
  const start = panel.rows.findIndex((row) => row.trimStart().startsWith(COMMAND_PROMPT));
  const first = panel.rows[start];
  if (first === undefined) return undefined;
  const lines = [first.trim().slice(COMMAND_PROMPT.length)];
  for (const row of panel.rows.slice(start + 1)) {
    if (row.trim() === '' || indentOf(row) <= indentOf(first)) break;
    lines.push(row.trim());
  }
  return lines.join(' ');
}

function panelShows(panel: ApprovalPanel, { name, target }: ApprovalExpectation, workspace: string): boolean {
  if (panel.tool !== name) return false;
  if (name !== 'Bash') return panel.rows.some((row) => namesFile(row.trim(), target, workspace));
  const command = panelCommand(panel);
  return command !== undefined && squash(command) === squash(target);
}

function permissionPicker(screen: Screen): PermissionPicker | undefined {
  const lines = screen.viewport.map((row) => row.trim());
  const title = lines.lastIndexOf(PERMISSION_PICKER);
  if (title < 0) return undefined;
  const known: readonly string[] = Object.values(PERMISSION_MODE_NAMES);
  const items = lines.slice(title + 1).flatMap((line) => {
    const match = PERMISSION_PICKER_ITEM.exec(line);
    const name = match?.[2];
    return name !== undefined && known.includes(name) ? [{ name, cursor: match?.[1] !== undefined, current: match?.[3] !== undefined }] : [];
  });
  if (items.length !== known.length) return undefined;
  return { names: items.map((item) => item.name), cursor: items.find((item) => item.cursor)?.name, current: items.find((item) => item.current)?.name };
}

function permissionNotices(screen: Screen): number {
  return screen.transcript.filter((row) => PERMISSION_NOTICES.some((prefix) => row.trimStart().startsWith(prefix))).length;
}

function permissionSet(screen: Screen, name: string): number {
  return screen.transcript.filter((row) => row.trim() === `${PERMISSION_SET}${name}`).length;
}

function rejectionNote(screen: Screen): string {
  const rows = screen.transcript.map((row) => row.trim());
  const start = rows.findLastIndex((row) => row.startsWith(REJECTED));
  if (start < 0) return '';
  const end = rows.findIndex((row, index) => index > start && row === '');
  return rows.slice(start, end < 0 ? undefined : end).join(' ');
}

function showsActivity(screen: Screen): boolean {
  return screen.status.some((line) => ACTIVITY.test(line));
}

function queuedMessages(screen: Screen): string[] {
  return screen.status.filter((line) => line.startsWith(QUEUED_ITEM)).map((line) => line.slice(QUEUED_ITEM.length));
}

function queuedCutShort(screen: Screen, text: string): boolean {
  return queuedMessages(screen).some((line) => line.endsWith(CUT_SHORT) && text.startsWith(line.slice(0, -CUT_SHORT.length)));
}

function toolHead({ name, target, status }: ToolExpectation): string {
  if (name === 'AskUserQuestion') return ASKED;
  if (name === 'Bash') return `${status === 'running' ? 'Running' : 'Ran'} a command · $ ${target}`;
  return `Used ${name} (${target})`;
}

function toolStatus(block: Block): ToolStatus | undefined {
  if (block.mark === USER_MARK) return undefined;
  if (block.mark === DONE_MARK) return UNFINISHED_TOOL.test(block.head) ? 'running' : 'done';
  return squash(block.text).includes(squash(REJECTION_NOTICE)) ? 'rejected' : 'failed';
}

function printedLines(block: Block): string[] {
  const lines = block.text.split('\n').slice(1);
  const note = lines.findIndex((line) => TRANSCRIPT_NOTES.some((prefix) => line.startsWith(prefix)));
  return (note < 0 ? lines : lines.slice(0, note)).map((line) => (line.startsWith(EARLIER_LINES_HIDDEN) ? line.slice(EARLIER_LINES_HIDDEN.length) : line));
}

function showsTool(screen: Screen, expectation: ToolExpectation): boolean {
  const head = toolHead(expectation);
  const output = wantedOutput(expectation);
  return latestTurn(screen).some(
    (block) =>
      (block.head === head || block.head.startsWith(`${head} · `)) &&
      toolStatus(block) === expectation.status &&
      (expectation.name !== 'AskUserQuestion' || asksQuestion(block, expectation.target)) &&
      (output === undefined || printedLines(block).includes(output)),
  );
}

function endsWithStopNotice(screen: Screen): boolean {
  return screen.transcript.findLast((row) => row.trim() !== '')?.trimStart().startsWith(TURN_STOPPED) === true;
}

function groupedReads(screen: Screen): GroupedRead[] {
  return latestTurn(screen)
    .filter((block) => READ_GROUP.test(block.head))
    .flatMap((block) => block.text.split('\n'))
    .flatMap((line): GroupedRead[] => {
      const file = READ_GROUP_FILE.exec(line);
      if (file?.[1] === undefined) return [];
      if (file[2] === READ_GROUP_PENDING) return [{ path: file[1], status: undefined }];
      return [{ path: file[1], status: file[2] === READ_GROUP_FAILED ? 'failed' : 'done' }];
    });
}

function showsReadGroup(screen: Screen): boolean {
  return latestTurn(screen).some((block) => READ_GROUP.test(block.head));
}

function showsGroupedRead(screen: Screen, expectation: ToolExpectation): boolean {
  return groupedReads(screen).some((file) => file.path === expectation.target && file.status === expectation.status);
}

function showsReply(screen: Screen, text: string): boolean {
  return latestTurn(screen).some(
    (block) => block.mark === DONE_MARK && !TOOL_CARD.test(block.head) && squash(block.text).includes(squash(text)),
  );
}

function replyCount(screen: Screen, text: string): number {
  return latestTurn(screen)
    .filter((block) => block.mark === DONE_MARK && !TOOL_CARD.test(block.head))
    .reduce((sum, block) => sum + squash(block.text).split(squash(text)).length - 1, 0);
}

function conversationBlocks(screen: Screen): Block[] {
  return blocksOf(screen).filter((block) => block.mark === USER_MARK || (block.mark === DONE_MARK && !TOOL_CARD.test(block.head)));
}

function transcriptCount(screen: Screen, text: string): number {
  return conversationBlocks(screen).reduce((sum, block) => sum + squash(block.text).split(squash(text)).length - 1, 0);
}

function conversationEntries(screen: Screen): string {
  const entries = conversationBlocks(screen).map((block) => `${block.mark} ${block.text.replaceAll('\n', '\n  ')}`);
  return entries.length === 0 ? '(no messages)' : entries.join('\n');
}

function terminalModes(output: string, exitStatus: RegExp): readonly string[] | undefined {
  const marker = output.search(exitStatus);
  if (marker < 0) return undefined;
  const words = output.slice(marker).replaceAll(TERMINAL_ESCAPE, ' ').split(/[\s;]+/);
  return words.includes('icanon') || words.includes('-icanon') ? words : undefined;
}

function latestTurnEntries(screen: Screen): string {
  const entries = latestTurn(screen).map((block) => `${block.mark} ${block.text.replaceAll('\n', '\n  ')}`);
  return entries.length === 0 ? '(nothing after the last user message)' : entries.join('\n');
}

class TuiDriver implements SurfaceDriver<'tui'> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly networkLog: string;
  private readonly exitStatus: RegExp;
  private readonly terminal = new VirtualTerminal(COLUMNS, ROWS);
  private readonly inputs: string[] = [];
  private output = '';
  private unshown = '';
  private stderr = '';
  private readonly lastPrompt: string | undefined;
  private readonly workspace: string;
  private released = false;
  private left = false;
  private turn: Turn | undefined;

  constructor(child: ChildProcessWithoutNullStreams, networkLog: string, exitMarker: string, { workspace, lastPrompt }: { readonly workspace: string; readonly lastPrompt: string | undefined }) {
    this.child = child;
    this.networkLog = networkLog;
    this.workspace = workspace;
    this.lastPrompt = lastPrompt;
    this.exitStatus = new RegExp(`${exitMarker}(\\d+)`);
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      this.output = (this.output + text).slice(-OUTPUT_TAIL);
      this.show(text);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-OUTPUT_TAIL);
    });
    child.stdin.on('error', (error) => {
      this.stderr = `${this.stderr}stdin: ${error.message}\n`;
    });
    child.once('close', () => {
      this.terminal.write(this.unshown);
      this.unshown = '';
      this.released = true;
    });
    this.terminal.onReply((reply) => {
      if (this.exitCode() === undefined && child.stdin.writable) child.stdin.write(reply);
    });
  }

  async ready(workspaceTrust?: SurfaceLaunch['workspaceTrust']): Promise<void> {
    if (workspaceTrust !== undefined) {
      await this.wait('the workspace trust prompt', (screen) =>
        screen.viewport.some((line) => line.includes('Trust this project?')) &&
        screen.viewport.some((line) => line.includes('Trust and continue'))
          ? true
          : undefined,
      );
      if (workspaceTrust === 'exit') {
        this.write(KEYS.escape);
        await this.waitForExit('declining workspace trust');
        return;
      }
      this.write(KEYS.up);
      await this.wait('the Trust and continue option to be selected', (screen) =>
        screen.viewport.some((line) => line.trim() === '❯ Trust and continue') ? true : undefined,
      );
      this.write(KEYS.enter);
    }
    await this.wait('the TUI to show its editor and the configured model', (screen) =>
      screen.input === 'editor' && screen.viewport.some((line) => line.includes(FAKE_PROVIDER_DEFAULTS.modelName)) ? true : undefined,
    );
    const { lastPrompt } = this;
    if (lastPrompt !== undefined) {
      await this.wait(`the resumed conversation to show ${JSON.stringify(lastPrompt)}`, (screen) => (userMessages(screen, lastPrompt) > 0 ? true : undefined));
    }
  }

  async idle(): Promise<boolean> {
    return this.turnOver(await this.read());
  }

  reopenState(): ReopenState {
    return {};
  }

  async expectTranscript(text: string): Promise<void> {
    const settled = await this.settle(`${JSON.stringify(text)} in the conversation`, (screen) => (transcriptCount(screen, text) > 0 ? screen : undefined));
    if ('over' in settled) {
      throw this.failure(`expectTranscript() did not find ${JSON.stringify(text)} in the conversation. It shows:\n${conversationEntries(settled.over)}`, settled.over);
    }
    const times = transcriptCount(settled.found, text);
    if (times > 1) {
      throw this.failure(
        `expectTranscript() found ${JSON.stringify(text)} ${times} times in the conversation; it must appear exactly once.\n${conversationEntries(settled.found)}`,
        settled.found,
      );
    }
  }

  exit(): Promise<void> {
    return this.leave('exit()');
  }

  async expectTerminalRestored(): Promise<void> {
    if (!this.left) throw new Error('expectTerminalRestored() reads the shell after the CLI has left; call exit() first.');
    let modes: readonly string[] | undefined;
    try {
      modes = await until('the shell to print its terminal modes', () => terminalModes(this.output, this.exitStatus), { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`expectTerminalRestored() found no terminal modes printed by the shell after the CLI exited.\n${await this.describe()}`, { cause });
    }
    const off = RESTORED_MODES.filter((mode) => !modes.includes(mode) || modes.includes(`-${mode}`));
    if (off.length > 0) {
      throw new Error(`The shell got the terminal back with ${off.join(' and ')} off after the CLI exited.\nModes: ${modes.join(' ')}\n${await this.describe()}`);
    }
  }

  async send(text: string): Promise<void> {
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure('send() needs an idle product, but a turn is running, a message is queued or an approval is pending.', screen);
    }
    const shown = userMessages(screen, text);
    this.turn = { stopped: statusLines(screen, TURN_STOPPED), failed: statusLines(screen, TURN_FAILED) };
    this.write(paste(text));
    this.write(KEYS.enter);
    await this.wait(`the user message ${JSON.stringify(text)} to appear in the transcript`, (current) =>
      userMessages(current, text) > shown ? true : undefined,
    );
  }

  async queue(text: string): Promise<void> {
    const screen = await this.read();
    this.assertTurnRunning('queue()', screen);
    if (queuedMessages(screen).includes(text)) {
      throw this.failure(`queue() found ${JSON.stringify(text)} already in the queue; queue each message once.`, screen);
    }
    this.write(paste(text));
    this.write(KEYS.queue);
    const settled = await this.settle(`the message ${JSON.stringify(text)} to wait in the queue`, (current) => {
      if (queuedMessages(current).includes(text)) return 'queued' as const;
      return queuedCutShort(current, text) ? ('cut' as const) : undefined;
    });
    if ('over' in settled) {
      throw this.failure(`queue() did not see ${JSON.stringify(text)} in the queue before the turn ended.`, settled.over);
    }
    if (settled.found === 'cut') {
      throw this.failure(`queue() put ${JSON.stringify(text)} in the queue, but the queue cuts it short to fit one line; queue a shorter message.`, await this.read());
    }
  }

  async steer(text: string): Promise<void> {
    const screen = await this.read();
    this.assertTurnRunning('steer()', screen);
    if (queuedMessages(screen).length > 0) {
      throw this.failure(
        'steer() needs an empty queue: with messages queued, Ctrl+S on the terminal UI steers the whole queue into the turn along with this message, while Desktop and Web steer only this one. Let the queue run first.',
        screen,
      );
    }
    const shown = userMessages(screen, text);
    this.write(paste(text));
    this.write(KEYS.steer);
    const settled = await this.settle(`the message ${JSON.stringify(text)} to reach the running turn`, (current) =>
      userMessages(current, text) > shown && !queuedMessages(current).includes(text) ? true : undefined,
    );
    if ('over' in settled) {
      throw this.failure(`steer() did not see ${JSON.stringify(text)} reach the turn before it ended.`, settled.over);
    }
  }

  approve(options?: ApproveOptions): Promise<void> {
    if (options?.for === 'session') return this.answerApproval('approve()', KEYS.approveForSession, APPROVED_FOR_SESSION);
    return this.answerApproval('approve()', KEYS.approveOnce, APPROVED);
  }

  reject(): Promise<void> {
    return this.answerApproval('reject()', KEYS.reject, REJECTED);
  }

  async rejectWithFeedback(feedback: string): Promise<void> {
    const screen = await this.pendingApproval('rejectWithFeedback()');
    const rejected = statusLines(screen, REJECTED);
    this.write(KEYS.rejectWithFeedback);
    await this.wait('the approval to ask for feedback', (screen) => (screen.viewport.some((row) => row.trim() === FEEDBACK_HINT) ? true : undefined));
    this.write(paste(feedback));
    await this.wait(`the feedback ${JSON.stringify(feedback)} to appear in the approval`, (screen) =>
      screen.viewport.some((row) => row.includes(FEEDBACK_CHOICE) && squash(row).endsWith(squash(feedback))) ? true : undefined,
    );
    this.write(KEYS.enter);
    const answered = await this.wait('the transcript to record the rejection', (screen) => (statusLines(screen, REJECTED) > rejected ? screen : undefined));
    const note = rejectionNote(answered);
    if (!note.endsWith(`— "${feedback}"`)) {
      throw this.failure(`rejectWithFeedback() rejected the approval, but the transcript recorded it without the reason ${JSON.stringify(feedback)}: ${note}`, answered);
    }
  }

  async expectApproval(expectation: ApprovalExpectation): Promise<void> {
    const wanted = describeApproval(expectation);
    const settled = await this.settle(`an approval for ${wanted}`, (screen) => (showsQuestion(screen) ? QUESTION_TITLE : approvalPanel(screen)));
    if ('over' in settled) {
      throw this.failure(`expectApproval() found no approval for ${wanted}: the turn ended without asking for one. It shows:\n${latestTurnEntries(settled.over)}`, settled.over);
    }
    if (settled.found === QUESTION_TITLE) throw this.failure(`expectApproval() found no approval for ${wanted}: ${QUESTION_PENDING}.`, await this.read());
    if (panelShows(settled.found, expectation, this.workspace)) return;
    throw this.failure(
      `expectApproval() found an approval, but it does not show ${wanted}. The approval shows:\n${settled.found.rows.join('\n').trimEnd()}`,
      await this.read(),
    );
  }

  async answer(option: string): Promise<void> {
    const { dialog, screen } = await this.singleChoiceQuestion('answer()');
    const offered = dialog.options.slice(0, -1);
    const choice = offered.find((candidate) => candidate.label === option);
    if (choice === undefined) {
      const scrolled = dialog.scrolls ? ' The list scrolls, so the terminal UI shows only some of the options; ask with fewer options.' : '';
      throw this.failure(`answer() found no option ${JSON.stringify(option)}. The question offers: ${offered.map((candidate) => JSON.stringify(candidate.label)).join(', ')}.${scrolled}`, screen);
    }
    this.write(choice.key);
    await this.submitAnswer(option);
  }

  async answerOther(text: string): Promise<void> {
    const { dialog, screen } = await this.singleChoiceQuestion('answerOther()');
    const other = dialog.options.at(-1);
    if (other === undefined) throw this.failure('answerOther() found no option to type an answer into.', screen);
    this.write(other.key);
    await this.wait('the question to take a typed answer', (current) => (questionDialog(current)?.typing === true ? true : undefined));
    this.write(paste(text));
    await this.wait(`the typed answer ${JSON.stringify(text)} to appear in the question`, (current) => {
      const typed = questionDialog(current)?.options.find((option) => option.key === other.key);
      return typed !== undefined && squash(typed.label) === squash(`${other.label}:${text}`) ? true : undefined;
    });
    this.write(KEYS.enter);
    await this.submitAnswer(text);
  }

  async dismissQuestion(): Promise<void> {
    const { screen } = await this.pendingQuestion('dismissQuestion()');
    const dismissed = dismissedQuestions(screen);
    this.write(KEYS.escape);
    await this.wait('the transcript to record that the question was dismissed', (current) => (dismissedQuestions(current) > dismissed ? true : undefined));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const name = PERMISSION_MODE_NAMES[mode];
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure('setPermissionMode() needs an idle product, but a turn is running or an approval is pending.', screen);
    }
    const notices = permissionNotices(screen);
    const set = permissionSet(screen, name);
    this.write(paste(PERMISSION_COMMAND));
    this.write(KEYS.enter);
    let picker = await this.wait('the permission mode picker to open', (current) => permissionPicker(current));
    if (picker.current === name) {
      this.write(KEYS.escape);
      await this.wait('the permission mode picker to close', (current) => (current.input === 'editor' && permissionPicker(current) === undefined ? true : undefined));
      throw this.failure(`setPermissionMode() asked for ${name}, but that is already the permission mode.`, await this.read());
    }
    while (picker.cursor !== name) {
      const from = picker.cursor;
      const below = picker.names.indexOf(name) > picker.names.indexOf(from ?? '');
      this.write(below ? KEYS.down : KEYS.up);
      picker = await this.wait('the permission mode picker to move its cursor', (current) => {
        const moved = permissionPicker(current);
        return moved !== undefined && moved.cursor !== from ? moved : undefined;
      });
    }
    this.write(KEYS.enter);
    const answered = await this.wait('the transcript to record the permission mode', (current) =>
      current.input === 'editor' && permissionNotices(current) > notices ? current : undefined,
    );
    if (permissionSet(answered, name) <= set) {
      throw this.failure(`setPermissionMode() chose ${name}, but the transcript did not record "${PERMISSION_SET}${name}".`, answered);
    }
  }

  async stop(): Promise<void> {
    const screen = await this.read();
    if (showsQuestion(screen)) {
      throw this.failure(
        `stop() cannot stop the turn: ${QUESTION_PENDING}. Esc and Ctrl+C on the terminal UI's question dismiss it, so a user there has no way to stop the turn without answering.`,
        screen,
      );
    }
    if (showsApproval(screen)) {
      throw this.failure(
        'stop() cannot stop a turn while an approval is pending on the terminal UI: Esc, Ctrl+C and Ctrl+D on the approval panel reject it, so a user there has no way to stop the turn without answering. Answer it with approve() or reject() first.',
        screen,
      );
    }
    if (this.turnOver(screen)) throw this.failure('stop() needs a running turn, but the product is idle.', screen);
    const stopped = statusLines(screen, TURN_STOPPED);
    this.write(KEYS.escape);
    const settled = await this.settle('the turn to stop', (current) =>
      statusLines(current, TURN_STOPPED) > stopped && !showsActivity(current) && endsWithStopNotice(current) ? true : undefined,
    );
    if ('over' in settled) {
      throw this.failure('stop() did not interrupt the turn: it ended on its own before the stop took effect.', settled.over);
    }
  }

  async waitIdle(): Promise<void> {
    const settled = await this.settle('the turn to end', (screen) => (showsApproval(screen) || showsQuestion(screen) ? screen : undefined));
    if ('over' in settled) return;
    if (showsQuestion(settled.found)) throw this.failure(`waitIdle() found the turn waiting: ${QUESTION_PENDING}.`, settled.found);
    throw this.failure('waitIdle() found a pending approval; answer it with approve() or reject() first.', settled.found);
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = describeTool(expectation);
    const settled = await this.settle(`the tool ${wanted}`, (screen) => {
      if (expectation.status === 'running' && this.turnOver(screen)) return undefined;
      if (showsTool(screen, expectation)) return 'card' as const;
      if (showsApproval(screen)) return expectation.status === 'running' ? ('approval' as const) : undefined;
      return expectation.name === 'Read' && showsReadGroup(screen) ? ('group' as const) : undefined;
    });
    if ('found' in settled && settled.found === 'approval') {
      throw this.failure(`expectTool() cannot find a running command while an approval is pending; answer it with approve() or reject() first.`, await this.read());
    }
    const missing = 'over' in settled ? settled.over : settled.found === 'group' ? await this.missingGroupedRead(expectation, wanted) : undefined;
    if (missing !== undefined) {
      const unnamed =
        expectation.name === 'AskUserQuestion' && dismissedQuestions(missing) > 0
          ? '\nThe terminal UI shows a dismissed question only as dismissed, without the question, so expectTool() cannot find it there.'
          : '';
      throw this.failure(`expectTool() did not find ${wanted}. The turn ended and it shows:\n${latestTurnEntries(missing)}${unnamed}`, missing);
    }
  }

  async expectReply(text: string): Promise<void> {
    const settled = await this.settle(`the reply ${JSON.stringify(text)}`, (screen) => (showsReply(screen, text) ? screen : undefined));
    if ('over' in settled) {
      throw this.failure(
        `expectReply() did not find ${JSON.stringify(text)} in an assistant reply. The turn ended and it shows:\n${latestTurnEntries(settled.over)}`,
        settled.over,
      );
    }
    const times = replyCount(settled.found, text);
    if (times > 1) {
      throw this.failure(
        `expectReply() found ${JSON.stringify(text)} ${times} times in the replies of the latest turn; it must appear exactly once.\n${latestTurnEntries(settled.found)}`,
        settled.found,
      );
    }
  }

  async expectError(text: string): Promise<void> {
    const settled = await this.settle(`a failure that mentions ${JSON.stringify(text)}`, (screen) =>
      failuresOf(screen).some((failure) => squash(failure).includes(squash(text))) ? true : undefined,
    );
    if ('found' in settled) return;
    const failures = failuresOf(settled.over);
    if (failures.length === 0) {
      const shown = rowsAfterLatestUserMessage(settled.over).join('\n').trimEnd();
      throw this.failure(`expectError() found no failure: the latest turn ended without one. After the latest user message it shows:\n${shown}`, settled.over);
    }
    throw this.failure(`expectError() found the latest turn failed, but not with ${JSON.stringify(text)}; it failed with:\n${failures.join('\n')}`, settled.over);
  }

  async expectAbsent(text: string): Promise<void> {
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure(
        'expectAbsent() needs an idle product, but a turn is running, a message is queued or an approval is pending: until the turn ends, text that has not appeared may still appear. Call waitIdle() first.',
        screen,
      );
    }
    const times = replyCount(screen, text);
    if (times > 0) {
      throw this.failure(`expectAbsent() found ${JSON.stringify(text)} ${times} time(s) in the replies of the latest turn.\n${latestTurnEntries(screen)}`, screen);
    }
  }

  async close(): Promise<void> {
    if (!this.left) await this.leave('The scenario');
  }

  private async leave(who: string): Promise<void> {
    if (this.exitCode() !== undefined) {
      throw new Error(`The CLI exited before ${who} closed it.\n${await this.describe()}`);
    }
    const screen = await this.read();
    if (!this.turnOver(screen)) {
      throw this.failure(`${who} left while a turn was running or an approval was pending; end the turn with waitIdle() first.`, screen);
    }
    this.write(KEYS.interrupt);
    this.write(paste('/exit'));
    this.write(KEYS.enter);
    await this.waitForExit('/exit');
  }

  private async waitForExit(action: string): Promise<void> {
    try {
      await until(`the CLI to exit after ${action}`, () => this.exitCode() !== undefined, { timeoutMs: TIMEOUTS.wait });
      this.child.stdin.end();
      await until('the pseudo-terminal to close', () => this.released, { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`The CLI did not exit cleanly after ${action}.\n${await this.describe()}`, { cause });
    }
    if (this.exitCode() !== 0) throw new Error(`The CLI exited with status ${String(this.exitCode())}.\n${await this.describe()}`);
    this.left = true;
  }

  async kill(): Promise<void> {
    if (this.released) return;
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) killProcessTree(this.child.pid);
    this.child.stdin.destroy();
    try {
      await until('the pseudo-terminal to close', () => this.released, { timeoutMs: TIMEOUTS.wait });
    } catch {
      this.stderr = `${this.stderr}The pseudo-terminal did not close after it was killed.\n`;
    }
  }

  networkViolations(): Promise<readonly string[]> {
    return readNetworkViolations(this.networkLog, 'The CLI in a pseudo-terminal');
  }

  async frame(): Promise<Frame> {
    const { viewport } = await this.read();
    const rows = viewport.map((row) => row.trimEnd());
    return { kind: 'text', text: rows.slice(0, rows.findLastIndex((row) => row !== '') + 1).join('\n') };
  }

  async diagnostics(): Promise<readonly Diagnostic[]> {
    const screen = await this.read();
    return [
      { name: 'tui-screen', body: screen.text },
      {
        name: 'tui-session',
        body: [
          `exit status: ${String(this.exitCode() ?? 'still running')}`,
          `recent input: ${JSON.stringify(this.inputs)}`,
          `stderr:\n${this.stderr === '' ? '(empty)' : this.stderr}`,
        ].join('\n'),
      },
    ];
  }

  private async missingGroupedRead(expectation: ToolExpectation, wanted: string): Promise<Screen | undefined> {
    this.write(KEYS.toggleDetails);
    try {
      await this.wait('the grouped reads to list their files', (screen) => (groupedReads(screen).length > 0 ? true : undefined));
      const settled = await this.settle(`the tool ${wanted} among the grouped reads`, (screen) =>
        showsGroupedRead(screen, expectation) ? true : undefined,
      );
      return 'over' in settled ? settled.over : undefined;
    } finally {
      this.write(KEYS.toggleDetails);
      await this.wait('the grouped reads to fold again', (screen) => (groupedReads(screen).length === 0 ? true : undefined));
    }
  }

  private async answerApproval(verb: string, key: string, recorded: string): Promise<void> {
    const screen = await this.pendingApproval(verb);
    const answered = statusLines(screen, recorded);
    this.write(key);
    await this.wait(`the transcript to record "${recorded.trim()}"`, (screen) =>
      statusLines(screen, recorded) > answered ? true : undefined,
    );
  }

  private async pendingApproval(verb: string): Promise<Screen> {
    const settled = await this.settle('an approval request', (screen) => (showsApproval(screen) || showsQuestion(screen) ? screen : undefined));
    if ('over' in settled) throw this.failure(`${verb} found no approval: the turn ended without asking for one.`, settled.over);
    if (showsQuestion(settled.found)) throw this.failure(`${verb} found no approval: ${QUESTION_PENDING}.`, settled.found);
    return settled.found;
  }

  private async pendingQuestion(verb: string): Promise<PendingQuestion> {
    const settled = await this.settle('a question', (screen): PendingQuestion | 'approval' | undefined => {
      const dialog = questionDialog(screen);
      if (dialog?.focused === true) return { dialog, screen };
      return showsApproval(screen) ? 'approval' : undefined;
    });
    if ('over' in settled) throw this.failure(`${verb} found no question: the turn ended without asking one.`, settled.over);
    if (settled.found === 'approval') throw this.failure(`${verb} found no question: ${APPROVAL_PENDING}.`, await this.read());
    return settled.found;
  }

  private async singleChoiceQuestion(verb: string): Promise<PendingQuestion> {
    const pending = await this.pendingQuestion(verb);
    const { dialog, screen } = pending;
    if (dialog.questions !== 1) {
      throw this.failure(`${verb} answers one question at a time, but the model asked ${dialog.questions} at once; dismiss them with dismissQuestion().`, screen);
    }
    if (!dialog.singleChoice) {
      throw this.failure(`${verb} answers a question that takes one choice, but this one lets the user pick several.`, screen);
    }
    return pending;
  }

  private async submitAnswer(answer: string): Promise<void> {
    const screen = await this.wait(`the question to show ${JSON.stringify(answer)} for review`, (current) =>
      reviewShows(questionDialog(current), answer) ? current : undefined,
    );
    const recorded = collectedAnswers(screen, answer);
    this.write(KEYS.enter);
    await this.wait(`the transcript to record the answer ${JSON.stringify(answer)}`, (current) => (collectedAnswers(current, answer) > recorded ? true : undefined));
  }

  private assertTurnRunning(verb: string, screen: Screen): void {
    if (showsQuestion(screen)) throw this.failure(`${verb} cannot send a message: ${QUESTION_PENDING}.`, screen);
    if (showsApproval(screen)) {
      throw this.failure(`${verb} cannot send a message while an approval is pending; answer it with approve() or reject() first.`, screen);
    }
    if (this.turnOver(screen)) throw this.failure(`${verb} needs a running turn, but the product is idle.`, screen);
  }

  private turnOver(screen: Screen): boolean {
    if (screen.input !== 'editor' || showsActivity(screen) || queuedMessages(screen).length > 0) return false;
    if (this.turn === undefined) return true;
    return (
      screen.status.some((line) => line.startsWith(TURN_COMPLETED)) ||
      statusLines(screen, TURN_STOPPED) > this.turn.stopped ||
      statusLines(screen, TURN_FAILED) > this.turn.failed
    );
  }

  private settle<T>(label: string, evidence: (screen: Screen) => T | undefined): Promise<Settled<T>> {
    let quiet: string | undefined;
    return this.wait<Settled<T>>(label, (screen) => {
      const found = evidence(screen);
      if (found !== undefined) return { found };
      if (!this.turnOver(screen)) {
        quiet = undefined;
        return undefined;
      }
      if (quiet === screen.text) return { over: screen };
      quiet = screen.text;
      return undefined;
    });
  }

  private async wait<T>(label: string, check: (screen: Screen) => T | undefined): Promise<T> {
    let outcome: { readonly value: T } | { readonly halted: string };
    try {
      outcome = await until(
        label,
        async () => {
          const screen = await this.read();
          const value = check(screen);
          if (value !== undefined) return { value };
          if (screen.height >= SCROLLBACK_LINES + ROWS) {
            return { halted: `The transcript outgrew the ${SCROLLBACK_LINES} lines the virtual terminal keeps, so evidence counted from the screen is no longer reliable.` };
          }
          return this.exitCode() === undefined ? undefined : { halted: 'The CLI exited.' };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${reason}\n${await this.describe()}`, { cause });
    }
    if ('halted' in outcome) throw new Error(`${outcome.halted} The test was waiting for ${label}.\n${await this.describe()}`);
    return outcome.value;
  }

  private async read(): Promise<Screen> {
    await this.terminal.flush();
    return screenOf(this.terminal.getScrollBuffer(), this.terminal.getViewport());
  }

  private show(text: string): void {
    const arrived = this.unshown + text;
    const begin = arrived.lastIndexOf(BEGIN_FRAME);
    const framed = begin > arrived.lastIndexOf(END_FRAME) ? begin : arrived.length - unfinishedBeginning(arrived);
    const whole = this.exitCode() === undefined ? framed : arrived.length;
    this.terminal.write(arrived.slice(0, whole));
    this.unshown = arrived.slice(whole);
  }

  private write(input: string): void {
    this.inputs.push(input.slice(-200));
    if (this.inputs.length > RECENT_INPUTS) this.inputs.shift();
    this.child.stdin.write(input);
  }

  private exitCode(): number | undefined {
    const match = this.exitStatus.exec(this.output);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  }

  private failure(message: string, screen: Screen): Error {
    return new Error(`${message}\nScreen:\n${screen.viewport.join('\n').trimEnd()}`);
  }

  private async describe(): Promise<string> {
    const screen = await this.read();
    return [
      `Screen:\n${screen.viewport.join('\n').trimEnd()}`,
      `Recent input: ${JSON.stringify(this.inputs)}`,
      `Exit status: ${String(this.exitCode() ?? 'still running')}`,
    ].join('\n');
  }
}

export async function startTui({ home, reopen, workspaceTrust }: SurfaceLaunch): Promise<SurfaceDriver<'tui'>> {
  if (process.platform === 'win32') throw new Error('The TUI surface needs the script command; Windows is not supported yet.');
  const command = kimiCliCommand();
  if (!existsSync(command.entry)) {
    throw new Error(`The CLI entry ${command.entry} does not exist; build the CLI before running against its bundle.`);
  }
  const launch = reopen?.launch ?? 1;
  const networkLog = join(home.root, `tui-network-${launch}.log`);
  const launcher = join(home.root, `tui-launch-${launch}.sh`);
  const preloads = [...(command.imports ?? []), NETWORK_GUARD_PRELOAD.href].flatMap((specifier) => ['--import', specifier]);
  const cli = [process.execPath, ...preloads, command.entry, ...(reopen === undefined ? [] : ['--continue'])].map(quote).join(' ');
  const exitMarker = `E2E_CLI_EXIT_${randomUUID()}=`;
  await writeFile(launcher, [`stty cols ${COLUMNS} rows ${ROWS}`, cli, `printf '\\n${exitMarker}%s\\n' "$?"`, 'stty -a', ''].join('\n'));
  const env = kimiCliEnv(home, {
    TERM: 'xterm-256color',
    ...(workspaceTrust === undefined ? {} : { KIMI_CODE_TRUST_WORKSPACE: undefined }),
  });
  const child = spawn('/bin/sh', ['-c', `cat | ${insidePseudoTerminal(launcher)}`], {
    cwd: home.workspace,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, ...command.env, ...networkGuardEnv(networkLog, offlineStubs()) },
  });
  const driver = new TuiDriver(child, networkLog, exitMarker, { workspace: home.workspace, lastPrompt: reopen?.lastPrompt });
  try {
    await driver.ready(reopen === undefined ? workspaceTrust : undefined);
  } catch (error) {
    await driver.kill();
    throw error;
  }
  return driver;
}
