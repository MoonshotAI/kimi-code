import { TIMEOUTS, until, WaitTimeoutError } from '@moonshot-ai/testkit/fixtures';
import type { Locator, Page } from '@playwright/test';

import {
  APPROVAL_PENDING,
  describeApproval,
  describeTool,
  namesFile,
  PERMISSION_MODE_NAMES,
  QUESTION_PENDING,
  waitOutcome,
  wantedOutput,
  describeChanges,
  missingChanges,
  type ApprovalExpectation,
  type ChangedLines,
  type SessionBadge,
  type TaskExpectation,
  type WaitExpectation,
  type WaitOutcome,
  type TaskStatus,
  type ApprovalToolName,
  type ApproveOptions,
  type DriverActionsOn,
  type PermissionMode,
  type ToolExpectation,
  type ToolName,
  type ToolStatus,
} from '../support/verbs';

const REJECTION_NOTICE = 'was not run because the user rejected the approval request';
const TOOL_LABELS: Readonly<Record<Exclude<ToolName, 'AskUserQuestion'>, string>> = { Read: 'Read', Edit: 'Edit', Write: 'Write', Bash: 'Run', WaitFor: 'Wait' };
const WAIT_SHOWS: { readonly [O in WaitOutcome | 'running']: RegExp } = {
  running: /^Waiting for /,
  finished: /^A task finished$/,
  interrupted: /^Wait interrupted by new input$/,
  'timed out': /^(?:Timed out|\d+ still running)$/,
};
const OUTPUT_PANEL = 'Output';
const PANEL_BODY = 'xpath=ancestor::*[2]/following-sibling::*[1]';
const INTERRUPT = /^(?:Interrupt|Press Esc again to interrupt)$/;
const SHOWN = ':not([inert], [inert] *)';
const LIST = '[role="list"]';
const ROW = '[role="listitem"]';
const STATE = '[role="status"]';
const MENU_BUTTON = 'button[aria-haspopup="menu"]';
const THINKING = 'Thinking';
const TO_BACKGROUND = 'To background';
const SESSION_ID = 'data-session-id';
const SESSION_TITLE = '.t';
const UNREAD_MARK = 'session-unread';
const PROJECT_ID = 'data-ws-id';
const REMOVE_PROJECT = 'Remove project';
const NEW_PROJECT = 'New Project';
const NEW_PROJECT_DIALOG = 'New project';
const ADD_FOLDERS = 'Click to add folders you can read and write';
const ADD_PROJECT_DIALOG = 'Add project';
const PROJECT_PATH = 'Path or folder search';
const ADD_ONE_FOLDER = 'Add folder (1)';
const LOADING_FOLDERS = 'Loading directories…';
const SESSION_BADGE_LABELS = { approval: 'Approve', question: 'Answer' } as const;
const OPEN_SESSION = /\/sessions\/([^/?#]+)/;
const FORK_SESSION = 'Fork session';
const DELETE_SESSION = 'Delete session';
const PERMANENTLY_DELETE = 'Permanently delete';
const DETAIL_PANEL = 'Detail panel';
const STOP_TASK = 'stop';
const RENDERER_TASK_STATUS: { readonly [S in TaskStatus]: string } = { running: 'running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const TASKS_PILL = /^(?:Bash|Background tasks)\b/;
const SETTINGS = 'Settings';
const SETTINGS_AGENT_TAB = 'Agent & Sessions';
const DEFAULT_PERMISSION = /^Default permission/;
const THINKING_SUFFIX = ' · ';
const PERMISSION_MODE_BUTTON = new RegExp(`^(?:${Object.values(PERMISSION_MODE_NAMES).join('|')})$`);
const DISCLOSURE = 'button[aria-expanded]';
const FOLDED = 'button[aria-expanded="false"]';
const MARKDOWN = 'p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table';
const BLOCK = `${ROW}${SHOWN}:not(:has(${LIST}))`;
const REPLY = `:not(:has(${DISCLOSURE})):not(:has(${STATE})):has(${MARKDOWN})`;
const ON_A_CARD = `${SHOWN}:not(:is(${MARKDOWN}), :is(${MARKDOWN}) *)`;
const DESCRIBED_LINES = 80;
const NEW_SESSION = 'New Session';
const COMPACT_COMMAND = '/compact';
const COMPACTED = /^Context compacted/;
const COMPACTION_FAILED = 'Context compaction failed';
const APPROVAL_TITLES: Readonly<Record<string, ApprovalToolName>> = { 'Run command?': 'Bash', 'Apply changes?': 'Edit', 'Write file?': 'Write' };
const COMMAND_PROMPT = '$ ';
const FEEDBACK_BOX = 'Explain why you are rejecting…';
const MANUALLY_STOPPED = 'Manually stopped';
const CONTINUE = 'Continue';
const QUEUE_WAITING = /\d+ waiting to send$/;
const QUESTION_MAIN = /^(?:Submit|Next question)$/;
const QUESTION_STEPS = /^(?:Next question|Back)$/;
const SUBMIT = 'Submit';
const SEND = 'Send ↵';
const UNDO_MESSAGE = 'Undo message';
const UNDO_DIALOG = 'Undo';
const CONFIRM = 'Confirm';
const DISMISS = 'Dismiss';
const OTHER_ANSWER = 'Other';
const ASKED = 'Collected your answers';
const UNANSWERED = ' —— No answer';

export type MenuPage = () => Promise<Page>;

type CardHandle = NonNullable<Awaited<ReturnType<Locator['elementHandle']>>>;

type Ask = 'approval' | 'question';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containing(text: string): RegExp {
  return new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function startingWith(text: string): RegExp {
  return new RegExp(`^${containing(text).source}`);
}

function cardShows(lines: readonly string[], { name, target }: ApprovalExpectation, workspace: string): boolean {
  const titles = lines.flatMap((line) => {
    const tool = APPROVAL_TITLES[line];
    return tool === undefined ? [] : [tool];
  });
  if (titles.length !== 1 || titles[0] !== name) return false;
  if (name === 'Bash') return lines.includes(`${COMMAND_PROMPT}${target}`);
  return lines.some((line) => namesFile(line, target, workspace));
}

function cardChanges(lines: readonly string[]): ChangedLines {
  const changed = (sign: string): string[] => lines.flatMap((line, index) => (line === sign && index + 1 < lines.length ? [lines[index + 1] ?? ''] : []));
  return { added: changed('+'), removed: changed('-') };
}

function modelOf(pill: string): string {
  const cut = pill.indexOf(THINKING_SUFFIX);
  return cut < 0 ? pill : pill.slice(0, cut);
}

function thinkingSuffixOf(pill: string): string {
  const cut = pill.indexOf(THINKING_SUFFIX);
  return cut < 0 ? '' : pill.slice(cut + THINKING_SUFFIX.length);
}

function effortLabelOf(level: string): string {
  return level.length === 0 ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

function shownThinking(level: string): string {
  if (level === 'off') return '';
  return level === 'on' ? THINKING : effortLabelOf(level);
}

interface SessionRowReading {
  readonly id: string;
  readonly title: string;
}

function describeRows(rows: readonly SessionRowReading[], current: string | undefined): string {
  if (rows.length === 0) return 'no sessions';
  return rows.map((row) => `${JSON.stringify(row.title)}${row.id === current ? ' (open)' : ''}`).join(', ');
}

export class RendererSurface implements DriverActionsOn<'desktop' | 'web'> {
  private readonly page: Page;
  private readonly workspace: string;
  private readonly menus: MenuPage;
  private recalled: string | undefined;
  private steered: string[] = [];

  constructor(page: Page, workspace: string, menus: MenuPage) {
    this.page = page;
    this.workspace = workspace;
    this.menus = menus;
  }

  async send(text: string): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`send() needs an idle product, but a turn is running, a message is queued or an approval is pending.\n${await this.describe()}`);
    }
    await this.assertEmptyInput('send()');
    const before = await this.conversationSize();
    await this.press('send()', 'the message input', this.composer());
    await this.page.keyboard.type(text);
    await this.enter(text, before);
    this.steered = [];
  }

  async submit(text: string): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`submit() needs an idle product, but a turn is running, a message is queued or an approval is pending.\n${await this.describe()}`);
    }
    const held = await this.composerText();
    if (held !== text) throw new Error(`submit() expected the message input to hold ${JSON.stringify(text)}, but it holds ${JSON.stringify(held)}.\n${await this.describe()}`);
    const before = await this.conversationSize();
    await this.focusComposer('submit()');
    await this.enter(text, before);
    this.steered = [];
  }

  async expectComposer(text: string): Promise<void> {
    let held = '';
    const settled = await this.settle(
      `the message input to hold ${JSON.stringify(text)}`,
      async () => {
        held = await this.composerText();
        return held === text;
      },
      [this.composer()],
    );
    if (settled === 'over') {
      throw new Error(`expectComposer() expected the message input to hold ${JSON.stringify(text)}, but it holds ${JSON.stringify(held)}.\n${await this.describe()}`);
    }
  }

  async recallPrevious(): Promise<void> {
    const before = await this.composerText();
    if (before !== '' && before !== this.recalled) {
      throw new Error(
        `recallPrevious() needs an empty message input, or one holding the prompt it recalled last; it holds ${JSON.stringify(before)}, and the up key there moves the cursor instead of walking the history.\n${await this.describe()}`,
      );
    }
    await this.focusComposer('recallPrevious()');
    await this.page.keyboard.press('ArrowUp');
    try {
      this.recalled = await until(
        'an earlier prompt to appear in the message input',
        async () => {
          const now = await this.composerText();
          return now !== '' && now !== before ? now : undefined;
        },
        { timeoutMs: TIMEOUTS.wait },
      );
    } catch (cause) {
      if (!(cause instanceof WaitTimeoutError)) throw cause;
      throw new Error(`recallPrevious() found no earlier prompt: the message input did not change.\n${await this.describe()}`, { cause });
    }
  }

  async undo(): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`undo() needs an idle product, but a turn is running, a message is queued or an approval is pending.\n${await this.describe()}`);
    }
    await this.assertEmptyInput('undo()');
    const rows = this.userRows();
    const count = await rows.count();
    if (count === 0) throw new Error(`undo() found no user message to withdraw.\n${await this.describe()}`);
    const latest = rows.last();
    await latest.hover({ timeout: TIMEOUTS.wait });
    await this.press('undo()', UNDO_MESSAGE, latest.getByRole('button', { name: UNDO_MESSAGE, exact: true }));
    await this.press('undo()', CONFIRM, this.page.getByRole('dialog', { name: UNDO_DIALOG, exact: true }).getByRole('button', { name: CONFIRM, exact: true }));
    await this.wait('the withdrawn message to leave the conversation and come back to the message input', async () =>
      (await rows.count()) < count && (await this.composerText()) !== '' ? true : undefined,
    );
    this.recalled = undefined;
  }

  private async enter(text: string, before: number): Promise<void> {
    const send = this.page.getByRole('button', { name: SEND, exact: true, disabled: false });
    await this.wait('the Send button to become enabled', async () => (await send.isVisible()) || undefined);
    await this.page.keyboard.press('Enter');
    this.recalled = undefined;
    await this.wait(`the user message ${JSON.stringify(text)} to appear in the conversation`, () => this.messageAfter(before, text));
  }

  private async focusComposer(verb: string): Promise<void> {
    if ((await this.composer().and(this.page.locator(':focus')).count()) === 0) await this.press(verb, 'the message input', this.composer());
  }

  private async composerText(): Promise<string> {
    return (await this.composer().getByRole('paragraph').allTextContents()).join('\n').trimEnd();
  }

  private async assertEmptyInput(verb: string): Promise<void> {
    const held = await this.composerText();
    if (held !== '') throw new Error(`${verb} needs an empty message input, but it holds ${JSON.stringify(held)}; send it with submit() first.\n${await this.describe()}`);
  }

  async queue(text: string): Promise<void> {
    await this.assertTurnRunning('queue()');
    await this.assertEmptyInput('queue()');
    if ((await this.queuedMessage(text).count()) > 0) {
      throw new Error(`queue() found ${JSON.stringify(text)} already in the queue; queue each message once.\n${await this.describe()}`);
    }
    await this.press('queue()', 'the message input', this.composer());
    await this.page.keyboard.type(text);
    await this.page.keyboard.press('ControlOrMeta+Enter');
    if ((await this.settle(`the message ${JSON.stringify(text)} to wait in the queue`, async () => (await this.queuedMessage(text).count()) > 0)) === 'over') {
      throw new Error(`queue() did not see ${JSON.stringify(text)} in the queue before the turn ended.\n${await this.describe()}`);
    }
  }

  async steer(text: string): Promise<void> {
    await this.assertTurnRunning('steer()');
    await this.assertEmptyInput('steer()');
    if (await this.queueShown()) {
      throw new Error(
        `steer() needs an empty queue: with messages queued, Ctrl+S on the terminal UI steers the whole queue into the turn along with this message, while Desktop and Web steer only this one. Let the queue run first.\n${await this.describe()}`,
      );
    }
    const latest = await this.latestUserPosition();
    await this.press('steer()', 'the message input', this.composer());
    await this.page.keyboard.type(text);
    await this.page.keyboard.press('Enter');
    this.steered.push(text);
    const reached = async (): Promise<boolean> => (await this.userMessages(latest + 1, text).count()) > 0 && (await this.queuedMessage(text).count()) === 0;
    if ((await this.settle(`the message ${JSON.stringify(text)} to reach the running turn`, reached)) === 'over') {
      throw new Error(`steer() did not see ${JSON.stringify(text)} reach the turn before it ended.\n${await this.describe()}`);
    }
  }

  async background(): Promise<void> {
    if (await this.questionShown()) throw new Error(`background() cannot move a command: ${QUESTION_PENDING}.\n${await this.describe()}`);
    if (await this.approvalShown()) throw new Error(`background() cannot move a command while an approval is pending; answer it with approve() or reject() first.\n${await this.describe()}`);
    const button = this.turnItems().getByRole('button', { name: TO_BACKGROUND, exact: true });
    const offered = await button.count();
    if (offered !== 1) throw new Error(`background() found no running command to move to the background: ${offered} command card(s) offer ${TO_BACKGROUND}.\n${await this.describe()}`);
    await this.press('background()', TO_BACKGROUND, button);
    await this.wait('the command to move to the background', async () => ((await button.count()) === 0 ? true : undefined));
  }

  async expectTask({ description, status, output }: TaskExpectation): Promise<void> {
    const pill = this.page.getByRole('button', { name: TASKS_PILL }).first();
    if ((await pill.count()) === 0) throw new Error(`expectTask() found no background tasks: the conversation shows no tasks button.\n${await this.describe()}`);
    const opened = (await pill.getAttribute('aria-pressed')) === 'true';
    if (!opened) await this.press('expectTask()', 'the background tasks', pill);
    const entry = this.page.getByRole('button', { name: description, exact: true }).last();
    try {
      if ((await this.settle(`the task ${JSON.stringify(description)} in the task list`, async () => (await entry.count()) > 0)) === 'over' && (await entry.count()) === 0) {
        const listed = await this.page.getByRole('button', { name: TASKS_PILL }).first().textContent();
        throw new Error(`expectTask() found no task described as ${JSON.stringify(description)} (${String(listed)}).\n${await this.describe()}`);
      }
      const shown = await entry.locator('xpath=..').getByRole('img').first().getAttribute('aria-label');
      if (shown !== RENDERER_TASK_STATUS[status]) {
        throw new Error(`expectTask() found ${JSON.stringify(description)} ${String(shown)}, not ${RENDERER_TASK_STATUS[status]}.\n${await this.describe()}`);
      }
      if (output !== undefined) await this.expectTaskOutput(description, entry, output);
    } finally {
      if (!opened && (await pill.getAttribute('aria-pressed')) === 'true') await this.press('expectTask()', 'the background tasks, to close them', pill);
    }
  }

  async stopTask(description: string): Promise<void> {
    const pill = this.page.getByRole('button', { name: TASKS_PILL }).first();
    if ((await pill.count()) === 0) throw new Error(`stopTask() found no background tasks: the conversation shows no tasks button.\n${await this.describe()}`);
    const opened = (await pill.getAttribute('aria-pressed')) === 'true';
    if (!opened) await this.press('stopTask()', 'the background tasks', pill);
    try {
      const row = this.page.getByRole('button', { name: description, exact: true }).last().locator('xpath=..');
      const stop = row.getByRole('button', { name: STOP_TASK, exact: true });
      if ((await stop.count()) === 0) {
        throw new Error(`stopTask() needs a running task described as ${JSON.stringify(description)}, but the task list offers no stop button for it.\n${await this.describe()}`);
      }
      await this.press('stopTask()', STOP_TASK, stop);
      await this.wait(`the task ${JSON.stringify(description)} to show ${RENDERER_TASK_STATUS.stopped}`, async () =>
        (await row.getByRole('img').first().getAttribute('aria-label')) === RENDERER_TASK_STATUS.stopped ? true : undefined,
      );
    } finally {
      if (!opened && (await pill.getAttribute('aria-pressed')) === 'true') await this.press('stopTask()', 'the background tasks, to close them', pill);
    }
  }

  private async expectTaskOutput(description: string, entry: Locator, output: string): Promise<void> {
    await this.press('expectTask()', description, entry);
    const panel = this.page.getByRole('complementary', { name: DETAIL_PANEL });
    const line = panel.getByText(output, { exact: true });
    const found = await this.wait(`the output of ${JSON.stringify(description)} to show ${JSON.stringify(output)}`, async () => ((await line.count()) > 0 ? true : undefined)).catch(() => false);
    const lines = (await panel.innerText({ timeout: TIMEOUTS.wait })).split('\n').map((text) => text.trim());
    await this.press('expectTask()', 'Close tab', panel.getByRole('button', { name: 'Close tab', exact: true }).first());
    if (!found) throw new Error(`expectTask() found ${JSON.stringify(description)}, but its output has no line ${JSON.stringify(output)}; it shows:\n${lines.join('\n')}\n${await this.describe()}`);
  }

  async steerQueued(): Promise<void> {
    await this.assertTurnRunning('steerQueued()');
    await this.assertEmptyInput('steerQueued()');
    const queued = (await this.queuePanel().getByRole('button').allTextContents()).map((text) => text.trim()).filter((text) => text !== '' && text !== 'Remove');
    if (queued.length !== 1) {
      throw new Error(
        `steerQueued() needs exactly one message in the queue, but ${queued.length} wait there: with several queued, Ctrl+S on the terminal UI steers them all into the turn while Desktop and Web steer only the first.\n${await this.describe()}`,
      );
    }
    const text = queued[0] ?? '';
    const latest = await this.latestUserPosition();
    await this.press('steerQueued()', 'the message input', this.composer());
    await this.page.keyboard.press('ControlOrMeta+s');
    this.steered.push(text);
    const reached = async (): Promise<boolean> => (await this.userMessages(latest + 1, text).count()) > 0 && !(await this.queueShown());
    if ((await this.settle(`the queued message ${JSON.stringify(text)} to reach the running turn`, reached)) === 'over') {
      throw new Error(`steerQueued() did not see ${JSON.stringify(text)} reach the turn before it ended.\n${await this.describe()}`);
    }
  }

  approve(options?: ApproveOptions): Promise<void> {
    return this.answerApproval('approve()', options?.for === 'session' ? this.approveForSessionButton() : this.approveButton());
  }

  reject(): Promise<void> {
    return this.answerApproval('reject()', this.rejectButton());
  }

  async rejectWithFeedback(feedback: string): Promise<void> {
    await this.pendingApproval('rejectWithFeedback()');
    await this.press('rejectWithFeedback()', 'Feedback', this.page.getByRole('button', { name: 'Feedback', exact: true }));
    const box = this.page.getByRole('textbox', { name: FEEDBACK_BOX, exact: true });
    await this.press('rejectWithFeedback()', 'the feedback box', box);
    await this.page.keyboard.type(feedback);
    await this.wait(`the feedback box to hold ${JSON.stringify(feedback)}`, async () => ((await box.inputValue({ timeout: TIMEOUTS.wait })) === feedback ? true : undefined));
    const submit = await this.page.getByRole('button', { name: 'Reject with feedback', exact: true }).elementHandle({ timeout: TIMEOUTS.wait });
    if (submit === null) throw new Error(`rejectWithFeedback() lost the approval before it could send the reason.\n${await this.describe()}`);
    await submit.click({ timeout: TIMEOUTS.wait });
    await submit.waitForElementState('hidden', { timeout: TIMEOUTS.server });
  }

  async expectApproval(expectation: ApprovalExpectation): Promise<void> {
    const wanted = describeApproval(expectation);
    const ask = await this.pendingAsk(`an approval for ${wanted}`);
    if (ask === undefined) throw new Error(`expectApproval() found no approval for ${wanted}: the turn ended without asking for one.\n${await this.describe()}`);
    if (ask === 'question') throw new Error(`expectApproval() found no approval for ${wanted}: ${QUESTION_PENDING}.\n${await this.describe()}`);
    const lines = (await this.approvalCard().innerText({ timeout: TIMEOUTS.wait }))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (!cardShows(lines, expectation, this.workspace)) {
      throw new Error(`expectApproval() found an approval, but it does not show ${wanted}. The approval shows:\n${lines.join('\n')}\n${await this.describe()}`);
    }
    const shown = cardChanges(lines);
    const missing = missingChanges(expectation, shown);
    if (missing.length > 0) {
      throw new Error(`expectApproval() found the approval, but its change does not show ${missing.join(', ')}. The change shows:\n${describeChanges(shown)}\n${await this.describe()}`);
    }
  }

  async answer(option: string): Promise<void> {
    const card = await this.singleQuestion('answer()');
    const choice = card.getByText(option, { exact: true });
    if ((await card.getByRole('textbox', { name: startingWith(option) }).count()) > 0) {
      throw new Error(`answer() picks a listed option, but ${JSON.stringify(option)} is where the user types an answer of their own; use answerOther().\n${await this.describe()}`);
    }
    if ((await choice.count()) !== 1) {
      throw new Error(`answer() found no option ${JSON.stringify(option)} on the question card. The card shows:\n${await this.cardLines(card)}\n${await this.describe()}`);
    }
    const recorded = await this.collectedAnswers(option);
    await this.press('answer()', option, choice);
    await this.submitAnswer('answer()', card, option, recorded);
  }

  async answerOther(text: string): Promise<void> {
    const card = await this.singleQuestion('answerOther()');
    const box = card.getByRole('textbox', { name: startingWith(OTHER_ANSWER) });
    const recorded = await this.collectedAnswers(text);
    await this.press('answerOther()', 'the box for an answer of their own', box);
    await this.page.keyboard.type(text);
    await this.wait(`the answer box to hold ${JSON.stringify(text)}`, async () => ((await box.inputValue({ timeout: TIMEOUTS.wait })) === text ? true : undefined));
    await this.submitAnswer('answerOther()', card, text, recorded);
  }

  async dismissQuestion(): Promise<void> {
    const card = await this.pendingQuestion('dismissQuestion()');
    const dismissed = (await this.unansweredQuestions()).length;
    const pressed = await card.getByRole('button', { name: DISMISS, exact: true }).last().elementHandle({ timeout: TIMEOUTS.wait });
    if (pressed === null) throw new Error(`dismissQuestion() lost the question before it could dismiss it.\n${await this.describe()}`);
    await pressed.click({ timeout: TIMEOUTS.wait });
    await pressed.waitForElementState('hidden', { timeout: TIMEOUTS.server });
    await this.wait('the conversation to record that the question was dismissed', async () => ((await this.unansweredQuestions()).length > dismissed ? true : undefined));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const name = PERMISSION_MODE_NAMES[mode];
    if (!(await this.idle())) {
      throw new Error(`setPermissionMode() needs an idle product, but a turn is running or an approval is pending.\n${await this.describe()}`);
    }
    const current = await this.wait('the permission mode button to show the current mode', () => this.shownMode());
    if (current === name) {
      throw new Error(`setPermissionMode() asked for ${name}, but that is already the permission mode.\n${await this.describe()}`);
    }
    await this.press('setPermissionMode()', current, this.modeButton(current));
    const choice = (await this.menus()).getByRole('menuitemradio', { name: startingWith(name) });
    await this.press('setPermissionMode()', name, choice);
    await this.wait(`the permission mode button to show ${name}`, async () => ((await this.modeButton(name).isVisible()) && !(await choice.isVisible()) ? true : undefined));
  }

  async chooseModel(name: string): Promise<void> {
    if (!(await this.idle())) throw new Error(`chooseModel() needs an idle product, but a turn is running or an approval is pending.\n${await this.describe()}`);
    const pill = this.modelPill();
    const shown = await this.wait('the model button to show the current model', async () => (await pill.textContent())?.trim() || undefined);
    if (modelOf(shown) === name) throw new Error(`chooseModel() asked for ${JSON.stringify(name)}, but that is already the model.\n${await this.describe()}`);
    await this.press('chooseModel()', 'the model button', pill);
    const menu = await this.menus();
    const choice = menu.getByRole('menuitemradio', { name: startingWith(name) }).first();
    if ((await choice.count()) === 0) {
      const offered = await menu.getByRole('menuitemradio').allTextContents();
      await this.page.keyboard.press('Escape');
      throw new Error(`chooseModel() found no model ${JSON.stringify(name)} in the model menu. It offers:\n${offered.join('\n')}\n${await this.describe()}`);
    }
    await this.press('chooseModel()', name, choice);
    await this.wait(`the model menu to mark ${JSON.stringify(name)} as chosen`, async () => ((await choice.getAttribute('aria-checked')) === 'true' ? true : undefined));
    await this.press('chooseModel()', 'the model button, to close the menu and apply the choice', pill);
    await this.wait(`the model button to show ${JSON.stringify(name)}`, async () => (modelOf((await pill.textContent())?.trim() ?? '') === name && !(await choice.isVisible()) ? true : undefined));
  }

  async setThinking(level: string): Promise<void> {
    if (!(await this.idle())) throw new Error(`setThinking() needs an idle product, but a turn is running or an approval is pending.\n${await this.describe()}`);
    const pill = this.modelPill();
    await this.press('setThinking()', 'the model button', pill);
    const menu = await this.menus();
    await this.press('setThinking()', THINKING, menu.getByRole('menuitem', { name: startingWith(THINKING) }));
    const label = effortLabelOf(level);
    const choice = menu.getByRole('menuitemradio', { name: label, exact: true });
    if ((await choice.count()) === 0) {
      const offered = await menu.getByRole('menuitemradio').allTextContents();
      await this.page.keyboard.press('Escape');
      throw new Error(`setThinking() found no thinking level ${JSON.stringify(level)} (${label} in the menu). The menu offers:\n${offered.join('\n')}\n${await this.describe()}`);
    }
    if ((await choice.getAttribute('aria-checked')) === 'true') {
      await this.page.keyboard.press('Escape');
      throw new Error(`setThinking() asked for ${JSON.stringify(level)}, but that is already the thinking level.\n${await this.describe()}`);
    }
    await this.press('setThinking()', label, choice);
    await this.wait(`the thinking menu to mark ${JSON.stringify(label)} as chosen`, async () => ((await choice.getAttribute('aria-checked')) === 'true' ? true : undefined));
    await this.press('setThinking()', 'the model button, to close the menu and apply the choice', pill);
    await this.wait(`the model button to show thinking ${JSON.stringify(level)}`, async () =>
      thinkingSuffixOf((await pill.textContent())?.trim() ?? '') === shownThinking(level) && !(await choice.isVisible()) ? true : undefined,
    );
  }

  async setDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    const name = PERMISSION_MODE_NAMES[mode];
    if (!(await this.idle())) {
      throw new Error(`setDefaultPermissionMode() needs an idle product, but a turn is running or an approval is pending.\n${await this.describe()}`);
    }
    await this.press('setDefaultPermissionMode()', SETTINGS, this.page.getByRole('button', { name: SETTINGS, exact: true }));
    const tabs = this.page.getByRole('tablist', { name: SETTINGS, exact: true });
    await this.press('setDefaultPermissionMode()', SETTINGS_AGENT_TAB, tabs.getByRole('tab', { name: SETTINGS_AGENT_TAB, exact: true }));
    const row = this.page.getByText(DEFAULT_PERMISSION).locator('xpath=ancestor::*').filter({ has: this.page.getByRole('tablist') }).last();
    const choice = row.getByRole('tab', { name, exact: true });
    const already = (await choice.getAttribute('aria-selected', { timeout: TIMEOUTS.wait })) === 'true';
    if (!already) {
      await this.press('setDefaultPermissionMode()', name, choice);
      await this.wait(`the default permission to show ${name}`, async () => ((await choice.getAttribute('aria-selected')) === 'true' ? true : undefined));
    }
    await this.page.keyboard.press('Escape');
    await this.wait('the settings to close', async () => ((await tabs.isVisible()) ? undefined : true));
    if (already) throw new Error(`setDefaultPermissionMode() asked for ${name}, but that is already the default permission.\n${await this.describe()}`);
  }

  async stop(): Promise<void> {
    if (await this.questionShown()) {
      throw new Error(
        `stop() cannot stop the turn: ${QUESTION_PENDING}. Esc on the question card dismisses it and the card hides the Interrupt button, so a user has no way to stop the turn without answering.\n${await this.describe()}`,
      );
    }
    if (await this.approvalShown()) {
      await this.stopWhileAsking();
      return;
    }
    if (await this.idle()) throw new Error(`stop() needs a running turn, but the product is idle.\n${await this.describe()}`);
    await this.press('stop()', 'Interrupt', this.interruptButton());
    await this.wait('the turn to stop', async () => ((await this.idle()) ? true : undefined));
    const replied = (await this.turnItems().count()) > 0;
    if (replied && (await this.stoppedMarks()) === 0) {
      throw new Error(`stop() did not interrupt the turn: it ended on its own before the stop took effect.\n${await this.describe()}`);
    }
  }

  async expectStopped(): Promise<void> {
    const settled = await this.settle(`the ${JSON.stringify(MANUALLY_STOPPED)} mark of the latest turn`, async () => (await this.stoppedMarks()) > 0);
    if (settled === 'over') {
      throw new Error(`expectStopped() found the latest turn ended without being stopped: it has no ${JSON.stringify(MANUALLY_STOPPED)} mark.\n${await this.describe()}`);
    }
  }

  async waitIdle(): Promise<void> {
    const ask = await this.pendingAsk('the turn to end');
    if (ask === 'question') throw new Error(`waitIdle() found the turn waiting: ${QUESTION_PENDING}.\n${await this.describe()}`);
    if (ask === 'approval') throw new Error(`waitIdle() found a pending approval; answer it with approve() or reject() first.\n${await this.describe()}`);
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = describeTool(expectation);
    const stuck: string[] = [];
    let waitingForApproval = false;
    const settled = await this.settle(`the tool ${wanted}`, async () => {
      if (expectation.status === 'running' && (await this.idle()) && !(await this.approvalShown())) return false;
      stuck.push(...(await this.unfoldGroups(expectation.name === 'WaitFor' ? this.turnWithSteered() : this.turnItems())));
      if (await this.showsTool(expectation, stuck)) return true;
      waitingForApproval = expectation.status === 'running' && (await this.approvalShown());
      return waitingForApproval;
    });
    if (waitingForApproval) {
      throw new Error(`expectTool() cannot find a running command while an approval is pending; answer it with approve() or reject() first.\n${await this.describe()}`);
    }
    if (settled === 'over') {
      const folded = stuck.length === 0 ? '' : `Folded tools or tool details could not be opened: ${stuck.join('; ')}\n`;
      throw new Error(`expectTool() did not find ${wanted}. ${folded}The turn ended and it shows:\n${await this.describe()}`);
    }
  }

  async expectReply(text: string): Promise<void> {
    const settled = await this.settle(
      `the reply ${JSON.stringify(text)}`,
      async () => (await this.replies().filter({ hasText: containing(text) }).count()) > 0,
    );
    if (settled === 'over') {
      throw new Error(`expectReply() did not find ${JSON.stringify(text)} in an assistant reply. The turn ended and it shows:\n${await this.describe()}`);
    }
    const flat = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
    const times = (await this.replies().allTextContents()).reduce((sum, reply) => sum + flat(reply).split(flat(text)).length - 1, 0);
    if (times > 1) {
      throw new Error(`expectReply() found ${JSON.stringify(text)} ${times} times in the replies of this turn; it must appear exactly once.\n${await this.describe()}`);
    }
  }

  async expectError(text: string): Promise<void> {
    const settled = await this.settle(
      `a failure that mentions ${JSON.stringify(text)}`,
      async () => (await this.failureCards().filter({ hasText: containing(text) }).count()) > 0,
      [this.failureCards()],
    );
    if (settled === 'found') return;
    const failures = await this.failureCards().allInnerTexts();
    if (failures.length === 0) throw new Error(`expectError() found no failure: the latest turn ended without one.\n${await this.describe()}`);
    throw new Error(
      `expectError() found the latest turn failed, but not with ${JSON.stringify(text)}; the failure shows:\n${failures.join('\n')}\n${await this.describe()}`,
    );
  }

  async expectAbsent(text: string): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(
        `expectAbsent() needs an idle product, but a turn is running, a message is queued or an approval is pending: until the turn ends, text that has not appeared may still appear. Call waitIdle() first.\n${await this.describe()}`,
      );
    }
    const times = await this.replies().filter({ hasText: containing(text) }).count();
    if (times > 0) throw new Error(`expectAbsent() found ${JSON.stringify(text)} in ${times} reply block(s) of the latest turn.\n${await this.describe()}`);
  }

  async continue(): Promise<void> {
    const failure = this.failureCards().filter({ has: this.continueButton() });
    if ((await this.settle('a failed turn with a Continue button', async () => (await failure.count()) > 0)) === 'over') {
      throw new Error(`continue() found no failed turn to continue: the latest turn ended without a failure, so there is no Continue button.\n${await this.describe()}`);
    }
    const card = await failure.elementHandle({ timeout: TIMEOUTS.wait });
    const pressed = await failure.getByRole('button', { name: CONTINUE, exact: true }).elementHandle({ timeout: TIMEOUTS.wait });
    if (card === null || pressed === null) throw new Error(`continue() lost the failed turn before it could press Continue.\n${await this.describe()}`);
    await pressed.click({ timeout: TIMEOUTS.wait });
    await card.waitForElementState('hidden', { timeout: TIMEOUTS.server });
  }

  async expectTranscript(text: string): Promise<void> {
    const settled = await this.settle(`${JSON.stringify(text)} in the conversation`, async () => (await this.transcriptCount(text)) > 0);
    if (settled === 'over') {
      throw new Error(`expectTranscript() did not find ${JSON.stringify(text)} in the conversation.\n${await this.describe()}`);
    }
    const times = await this.transcriptCount(text);
    if (times > 1) {
      throw new Error(`expectTranscript() found ${JSON.stringify(text)} ${times} times in the conversation; it must appear exactly once.\n${await this.describe()}`);
    }
  }

  async awaitMessage(text: string): Promise<void> {
    await this.wait(`the conversation to show the user message ${JSON.stringify(text)}`, async () => ((await this.userMessages(1, text).count()) > 0 ? true : undefined));
  }

  async idle(): Promise<boolean> {
    if (await this.approvalShown()) return false;
    if (await this.questionShown()) return false;
    if (await this.interruptButton().isVisible()) return false;
    if (await this.queueShown()) return false;
    return this.composer().isVisible();
  }

  async describe(): Promise<string> {
    if (this.page.isClosed()) return 'The page is closed.';
    try {
      const tree = await this.page.locator('body').ariaSnapshot();
      return `Page:\n${tree.split('\n').slice(-DESCRIBED_LINES).join('\n')}`;
    } catch (error) {
      return `The page could not be read: ${reasonOf(error)}`;
    }
  }

  async compact(): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`compact() needs an idle product, but a turn is running, a message is queued or an approval is pending.\n${await this.describe()}`);
    }
    const compacted = this.conversation().getByText(COMPACTED);
    const before = await compacted.count();
    const failed = this.conversation().getByText(COMPACTION_FAILED);
    const failedBefore = await failed.count();
    await this.press('compact()', 'the message input', this.composer());
    await this.page.keyboard.type(COMPACT_COMMAND);
    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press('Enter');
    const outcome = await this.wait(`the conversation to show Context compacted, or a ${COMPACTION_FAILED} divider`, async () => {
      if ((await failed.count()) > failedBefore) return 'failed' as const;
      return (await compacted.count()) > before && (await this.idle()) ? ('compacted' as const) : undefined;
    });
    if (outcome === 'failed') throw new Error(`compact() saw the compaction fail.\n${await this.describe()}`);
  }

  async newSession(): Promise<void> {
    if (!(await this.idle())) {
      throw new Error(`newSession() needs an idle product, but a turn is running, a message is queued or an approval is pending.\n${await this.describe()}`);
    }
    await this.press('newSession()', `the ${NEW_SESSION} button`, this.page.getByRole('button', { name: new RegExp(`^${NEW_SESSION}`) }).first());
    await this.wait('a new, empty conversation', async () => ((await this.conversationSize()) === 0 && (await this.composer().isVisible()) ? true : undefined));
  }

  async fork(): Promise<void> {
    const source = this.openSessionId();
    if (source === undefined) throw new Error(`fork() needs a session with messages, but the page has no session open.\n${await this.describe()}`);
    if ((await this.conversationSize()) === 0) throw new Error(`fork() needs a session with messages, but the conversation is empty.\n${await this.describe()}`);
    const before = new Set((await this.sessionRows()).map((row) => row.id));
    const menu = await this.sessionMenu('fork()', source);
    await this.press('fork()', FORK_SESSION, menu.getByRole('menuitem', { name: FORK_SESSION, exact: true }));
    await this.wait('the page to open the forked session', async () => {
      const opened = this.openSessionId();
      return opened !== undefined && opened !== source && !before.has(opened) && (await this.conversationSize()) > 0 ? true : undefined;
    });
  }

  async openSession(title: string): Promise<void> {
    const current = this.openSessionId();
    const rows = await this.sessionRows();
    const others = rows.filter((row) => row.title === title && row.id !== current);
    if (others.length !== 1) {
      const reason = others.length === 0 ? 'no other session has that title' : `${others.length} other sessions have that title`;
      throw new Error(`openSession() cannot pick the session ${JSON.stringify(title)}: ${reason}. The sidebar lists ${describeRows(rows, current)}.\n${await this.describe()}`);
    }
    const target = others[0]!.id;
    await this.press('openSession()', `the session ${JSON.stringify(title)}`, this.sessionRow(target).locator(SESSION_TITLE));
    await this.wait(`the page to open the session ${JSON.stringify(title)}`, async () => (this.openSessionId() === target && (await this.conversationSize()) > 0 ? true : undefined));
  }

  async deleteSession(title: string): Promise<void> {
    const target = await this.closedSession('deleteSession()', title);
    const menu = await this.sessionMenu('deleteSession()', target);
    await this.press('deleteSession()', 'Delete', menu.getByRole('menuitem', { name: 'Delete', exact: true }));
    const confirm = this.page.getByRole('dialog', { name: DELETE_SESSION });
    await this.press('deleteSession()', PERMANENTLY_DELETE, confirm.getByRole('button', { name: PERMANENTLY_DELETE, exact: true }));
    await this.wait(`the sidebar to drop the session ${JSON.stringify(title)}`, async () => ((await this.sessionRow(target).count()) === 0 ? true : undefined));
  }

  async archiveSession(title: string): Promise<void> {
    const target = await this.closedSession('archiveSession()', title);
    const menu = await this.sessionMenu('archiveSession()', target);
    await this.press('archiveSession()', 'Archive', menu.getByRole('menuitem', { name: 'Archive', exact: true }));
    await this.wait(`the sidebar to drop the session ${JSON.stringify(title)}`, async () => ((await this.sessionRow(target).count()) === 0 ? true : undefined));
  }

  async expectSessions(titles: readonly string[]): Promise<void> {
    const wanted = titles.toSorted();
    let previous: string | undefined;
    const shown = await this.wait(`the sidebar to list the sessions ${JSON.stringify(titles)}`, async () => {
      const listed = (await this.sessionRows()).map((row) => row.title).toSorted();
      const reading = JSON.stringify(listed);
      if (reading === JSON.stringify(wanted)) return listed;
      const settled = reading === previous && (await this.idle());
      previous = reading;
      return settled ? listed : undefined;
    });
    if (JSON.stringify(shown) !== JSON.stringify(wanted)) {
      throw new Error(`expectSessions() wanted the sidebar to list ${JSON.stringify(wanted)}, but it lists ${JSON.stringify(shown)}.\n${await this.describe()}`);
    }
  }

  async expectSessionBadge(title: string, badge: SessionBadge): Promise<void> {
    const rows = await this.sessionRows();
    const matching = rows.filter((row) => row.title === title);
    if (matching.length !== 1) {
      const reason = matching.length === 0 ? 'no session has that title' : `${matching.length} sessions have that title`;
      throw new Error(`expectSessionBadge() cannot pick the session ${JSON.stringify(title)}: ${reason}. The sidebar lists ${describeRows(rows, this.openSessionId())}.\n${await this.describe()}`);
    }
    const row = this.sessionRow(matching[0]!.id);
    const marks = async (): Promise<SessionBadge[]> => {
      const shown: SessionBadge[] = [];
      if ((await row.getByTestId(UNREAD_MARK).count()) > 0) shown.push('unread');
      if ((await row.getByText(SESSION_BADGE_LABELS.approval, { exact: true }).count()) > 0) shown.push('approval');
      if ((await row.getByText(SESSION_BADGE_LABELS.question, { exact: true }).count()) > 0) shown.push('question');
      return shown;
    };
    const wanted = (shown: readonly SessionBadge[]): boolean => (badge === 'none' ? shown.length === 0 : shown.includes(badge));
    let previous: string | undefined;
    const shown = await this.wait(`the session ${JSON.stringify(title)} to show ${badge === 'none' ? 'no mark' : `the ${badge} mark`}`, async () => {
      const now = await marks();
      const reading = JSON.stringify(now);
      if (wanted(now)) return now;
      const settled = reading === previous && (await this.idle());
      previous = reading;
      return settled ? now : undefined;
    });
    if (!wanted(shown)) {
      const listed = shown.length === 0 ? 'no mark' : shown.join(' and ');
      throw new Error(`expectSessionBadge() wanted the session ${JSON.stringify(title)} to show ${badge === 'none' ? 'no mark' : `the ${badge} mark`}, but it shows ${listed}.\n${await this.describe()}`);
    }
  }

  async removeWorkspace(): Promise<void> {
    const name = this.workspaceName();
    const group = this.projectGroup(name);
    if ((await group.count()) !== 1) throw new Error(`removeWorkspace() found no project ${JSON.stringify(name)} in the sidebar.\n${await this.describe()}`);
    await group.getByText(name, { exact: true }).first().hover({ timeout: TIMEOUTS.wait });
    await this.press('removeWorkspace()', 'the project options', group.getByRole('button', { name: 'Options', exact: true }).first());
    await this.press('removeWorkspace()', REMOVE_PROJECT, this.page.getByRole('menuitem', { name: REMOVE_PROJECT, exact: true }));
    const confirm = this.page.getByRole('dialog').filter({ hasText: `Remove "${name}" from the sidebar?` });
    await this.press('removeWorkspace()', 'Remove', confirm.getByRole('button', { name: 'Remove', exact: true }));
    await this.wait(`the sidebar to drop the project ${JSON.stringify(name)}`, async () => ((await group.count()) === 0 ? true : undefined));
  }

  async addWorkspace(): Promise<void> {
    const name = this.workspaceName();
    if ((await this.projectGroup(name).count()) > 0) throw new Error(`addWorkspace() found the project ${JSON.stringify(name)} already in the sidebar; remove it first.\n${await this.describe()}`);
    await this.press('addWorkspace()', NEW_PROJECT, this.sidebar().getByRole('button', { name: NEW_PROJECT, exact: true }));
    const dialog = this.page.getByRole('dialog', { name: NEW_PROJECT_DIALOG });
    await this.press('addWorkspace()', ADD_FOLDERS, dialog.getByRole('button', { name: ADD_FOLDERS, exact: true }));
    const picker = this.page.getByRole('dialog', { name: ADD_PROJECT_DIALOG });
    const path = picker.getByRole('combobox', { name: PROJECT_PATH, exact: true });
    const add = picker.getByRole('button', { name: 'Add', exact: true });
    await this.wait(`${ADD_PROJECT_DIALOG} to open its first folder`, async () =>
      (await path.inputValue({ timeout: TIMEOUTS.wait }).catch(() => '')) !== '' && (await picker.getByText(LOADING_FOLDERS, { exact: true }).count()) === 0 ? true : undefined,
    );
    try {
      await path.fill(this.workspace, { timeout: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`addWorkspace() could not type the folder into ${ADD_PROJECT_DIALOG}: ${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
    await this.wait(`${ADD_PROJECT_DIALOG} to accept the typed folder`, async () =>
      (await path.inputValue({ timeout: TIMEOUTS.wait }).catch(() => '')) === this.workspace && (await add.isVisible()) ? true : undefined,
    );
    await this.press('addWorkspace()', 'Add', add);
    await this.press('addWorkspace()', ADD_ONE_FOLDER, picker.getByRole('button', { name: ADD_ONE_FOLDER, exact: true }));
    await this.wait(`${ADD_PROJECT_DIALOG} to hand the folder to ${NEW_PROJECT_DIALOG}`, async () => ((await picker.count()) === 0 ? true : undefined));
    await this.press('addWorkspace()', 'Create', dialog.getByRole('button', { name: 'Create', exact: true }));
    await this.wait(`the sidebar to list the project ${JSON.stringify(name)}`, async () => ((await this.projectGroup(name).count()) === 1 && !(await dialog.isVisible()) ? true : undefined));
  }

  private workspaceName(): string {
    return this.workspace.slice(Math.max(this.workspace.lastIndexOf('/'), this.workspace.lastIndexOf('\\')) + 1);
  }

  private projectGroup(name: string): Locator {
    return this.sidebar().locator(`[${PROJECT_ID}]`).filter({ has: this.page.getByText(name, { exact: true }) });
  }

  private sidebar(): Locator {
    return this.page.getByRole('complementary').filter({ has: this.page.getByRole('button', { name: new RegExp(`^${NEW_SESSION}`) }) });
  }

  private sessionRow(id: string): Locator {
    return this.sidebar().locator(`[${SESSION_ID}=${quoted(id)}]`);
  }

  private async sessionRows(): Promise<SessionRowReading[]> {
    const read = await this.sidebar()
      .locator(`[${SESSION_ID}]`)
      .evaluateAll(
        (elements, selectors) =>
          elements.map((element) => ({ id: element.getAttribute(selectors.id) ?? '', title: (element.querySelector(selectors.title)?.textContent ?? '').trim() })),
        { id: SESSION_ID, title: SESSION_TITLE },
      );
    return read.filter((row, index) => read.findIndex((other) => other.id === row.id) === index);
  }

  private openSessionId(): string | undefined {
    return OPEN_SESSION.exec(this.page.url())?.[1];
  }

  private async closedSession(verb: string, title: string): Promise<string> {
    const rows = await this.sessionRows();
    const current = this.openSessionId();
    const matching = rows.filter((row) => row.title === title);
    if (matching.length !== 1 || matching[0]!.id === current) {
      const reason =
        matching.length === 0 ? 'no session has that title' : matching.length > 1 ? `${matching.length} sessions have that title` : 'it is the open session; open another one first';
      throw new Error(`${verb} cannot pick the session ${JSON.stringify(title)}: ${reason}. The sidebar lists ${describeRows(rows, current)}.\n${await this.describe()}`);
    }
    return matching[0]!.id;
  }

  private async sessionMenu(verb: string, id: string): Promise<Locator> {
    const row = this.sessionRow(id);
    try {
      await row.locator(SESSION_TITLE).click({ button: 'right', timeout: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`${verb} could not open the menu of the session ${id}: ${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
    const menu = this.page.getByRole('menu');
    await this.wait(`the menu of the session ${id} to open`, async () => ((await menu.count()) === 1 && (await menu.isVisible()) ? true : undefined));
    return menu;
  }

  async resize(viewport: { readonly width: number; readonly height: number }): Promise<void> {
    const area = await this.inputArea();
    const before = await area.boundingBox({ timeout: TIMEOUTS.wait }).catch(() => null);
    if (before === null) throw new Error(`resize() needs the message input, an approval or a question on screen to tell when the page has laid itself out again.\n${await this.describe()}`);
    await this.page.setViewportSize(viewport);
    let previous: string | undefined;
    await this.wait(`the message input, approval or question to settle inside a window ${viewport.width} pixels wide`, async () => {
      const box = await area.boundingBox({ timeout: TIMEOUTS.wait }).catch(() => null);
      if (box === null || box.width === before.width || box.x < 0 || box.x + box.width > viewport.width) {
        previous = undefined;
        return undefined;
      }
      const reading = JSON.stringify(box);
      const settled = reading === previous;
      previous = reading;
      return settled ? true : undefined;
    });
  }

  private async inputArea(): Promise<Locator> {
    if (await this.approvalShown()) return this.approvalCard();
    if (await this.questionShown()) return this.questionCard();
    return this.composer();
  }

  private approvalCard(): Locator {
    return this.minimizeButton().locator('xpath=ancestor::*').filter({ has: this.approveButton() }).last();
  }

  private composer(): Locator {
    return this.page.getByRole('combobox', { name: 'Message input' });
  }

  private modelPill(): Locator {
    const named = (scope: Locator | Page): Locator => scope.locator(MENU_BUTTON).filter({ hasText: /\S/ }).filter({ hasNotText: PERMISSION_MODE_BUTTON });
    const toolbar = this.page.getByRole('button', { name: SEND, exact: true }).locator('xpath=ancestor::*').filter({ has: named(this.page) }).last();
    return named(toolbar);
  }

  private failureCards(): Locator {
    return this.page
      .getByRole('alert')
      .and(this.page.locator(SHOWN))
      .filter({ has: this.page.getByRole('button', { name: CONTINUE, exact: true }) });
  }

  private continueButton(): Locator {
    return this.page.getByRole('button', { name: CONTINUE, exact: true });
  }

  private interruptButton(): Locator {
    return this.page.getByRole('button', { name: INTERRUPT });
  }

  private approveButton(): Locator {
    return this.page.getByRole('button', { name: 'Approve', exact: true });
  }

  private approveForSessionButton(): Locator {
    return this.page.getByRole('button', { name: 'Approve for session', exact: true });
  }

  private minimizeButton(): Locator {
    return this.page.getByRole('button', { name: 'Minimize', exact: true });
  }

  private expandButton(): Locator {
    return this.page.getByRole('button', { name: 'Expand', exact: true });
  }

  private modeButton(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  private async shownMode(): Promise<string | undefined> {
    for (const name of Object.values(PERMISSION_MODE_NAMES)) {
      if (await this.modeButton(name).isVisible()) return name;
    }
    return undefined;
  }

  private stoppedMarks(): Promise<number> {
    return this.turnItems().locator(STATE).filter({ hasText: MANUALLY_STOPPED }).count();
  }

  private async stopWhileAsking(): Promise<void> {
    const rejections = await this.turnItems().getByText(REJECTION_NOTICE).count();
    await this.press('stop()', 'Minimize', this.minimizeButton());
    await this.wait('the approval to fold away', async () =>
      (await this.expandButton().isVisible()) && !(await this.minimizeButton().isVisible()) && !(await this.approvalShown()) ? true : undefined,
    );
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
    await this.wait('the turn to stop', async () => ((await this.idle()) ? true : undefined));
    if ((await this.turnItems().getByText(REJECTION_NOTICE).count()) > rejections) {
      throw new Error(`stop() was meant to leave the approval unanswered, but the approval was rejected.\n${await this.describe()}`);
    }
    if ((await this.stoppedMarks()) === 0) {
      throw new Error(`stop() folded the approval away and pressed Esc twice, but the turn ended without being stopped.\n${await this.describe()}`);
    }
  }

  private rejectButton(): Locator {
    return this.page.getByRole('button', { name: 'Reject', exact: true });
  }

  private queueShown(): Promise<boolean> {
    return this.page.getByText(QUEUE_WAITING).first().isVisible();
  }

  private queuePanel(): Locator {
    return this.page
      .getByText(QUEUE_WAITING)
      .first()
      .locator('xpath=ancestor::*')
      .filter({ has: this.page.getByRole('button', { name: 'Remove', exact: true }) })
      .last();
  }

  private queuedMessage(text: string): Locator {
    return this.queuePanel().getByRole('button', { name: text, exact: true });
  }

  private async assertTurnRunning(verb: string): Promise<void> {
    if (await this.questionShown()) throw new Error(`${verb} cannot send a message: ${QUESTION_PENDING}.\n${await this.describe()}`);
    if (await this.approvalShown()) {
      throw new Error(`${verb} cannot send a message while an approval is pending; answer it with approve() or reject() first.\n${await this.describe()}`);
    }
    if (await this.idle()) throw new Error(`${verb} needs a running turn, but the product is idle.\n${await this.describe()}`);
  }

  private conversation(): Locator {
    return this.page
      .locator(LIST)
      .filter({ has: this.page.getByRole('button', { name: 'Copy', exact: true }) })
      .first();
  }

  private async conversationSize(): Promise<number> {
    const rows = this.conversation().locator(`:scope > ${ROW}`);
    if ((await rows.count()) === 0) return 0;
    const size = Number(await rows.last().getAttribute('aria-setsize', { timeout: TIMEOUTS.wait }));
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`send() could not tell how many messages the conversation holds.\n${await this.describe()}`);
    }
    return size;
  }

  private userRows(): Locator {
    return this.conversation()
      .locator(`:scope > ${ROW}`)
      .filter({ hasNot: this.page.locator(LIST) });
  }

  private userMessages(from: number, text: string): Locator {
    return this.conversation()
      .locator(`xpath=./*[@role="listitem" and number(@aria-posinset) >= ${from}]`)
      .filter({ hasNot: this.page.locator(LIST) })
      .filter({ has: this.page.getByText(text, { exact: true }) });
  }

  private async latestUserPosition(): Promise<number> {
    const rows = this.userRows();
    if ((await rows.count()) === 0) return 0;
    const position = Number(await rows.last().getAttribute('aria-posinset', { timeout: TIMEOUTS.wait }));
    if (!Number.isInteger(position) || position < 1) {
      throw new Error(`steer() could not tell where the latest user message sits in the conversation.\n${await this.describe()}`);
    }
    return position;
  }

  private async messageAfter(size: number, text: string): Promise<number | undefined> {
    const message = this.userMessages(size + 1, text).first();
    if ((await message.count()) === 0) return undefined;
    const position = Number(await message.getAttribute('aria-posinset', { timeout: TIMEOUTS.wait }));
    return Number.isInteger(position) ? position : undefined;
  }

  private async transcriptCount(text: string): Promise<number> {
    const rows = this.conversation().locator(`:scope > ${ROW}`);
    const rendered = await rows.count();
    if (rendered > 0) {
      const size = Number(await rows.last().getAttribute('aria-setsize', { timeout: TIMEOUTS.wait }));
      if (Number.isInteger(size) && size > rendered) {
        throw new Error(`expectTranscript() can read only the ${rendered} of ${size} messages the conversation has rendered; keep the scenario's conversation short enough to fit.`);
      }
    }
    const users = await rows.filter({ hasNot: this.page.locator(LIST) }).allTextContents();
    const replies = await this.conversation().locator(`${ROW} ${BLOCK}${REPLY}`).allTextContents();
    const flat = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
    return [...users, ...replies].reduce((sum, shown) => sum + flat(shown).split(flat(text)).length - 1, 0);
  }

  private turnItems(): Locator {
    return this.userRows().last().locator('xpath=following-sibling::*[@role="listitem"]');
  }

  private replies(): Locator {
    return this.turnItems().locator(`${BLOCK}${REPLY}`);
  }

  private toolCards({ name, target }: { readonly name: Exclude<ToolName, 'AskUserQuestion'>; readonly target: string }): Locator {
    const onCard = this.page.locator(ON_A_CARD);
    const labelled = this.turnItems()
      .locator(`${BLOCK}:not(${REPLY})`)
      .filter({ has: this.page.getByText(TOOL_LABELS[name], { exact: true }).and(onCard) });
    if (name === 'Bash') return labelled.filter({ has: this.page.getByText(target, { exact: true }).and(onCard) });
    const file = this.page
      .getByRole('button', { name: target.slice(target.lastIndexOf('/') + 1), exact: true })
      .and(this.page.locator(`[data-file-path=${quoted(target)}], [data-file-path=${quoted(`${this.workspace}/${target}`)}]`))
      .and(onCard);
    return labelled.filter({ has: file });
  }

  private async toolStatus(card: Locator): Promise<ToolStatus | undefined> {
    if ((await card.locator(`${STATE}${SHOWN}`).count()) === 0) return 'done';
    if ((await card.locator(`${STATE}[aria-label="running"]${SHOWN}`).count()) > 0) return 'running';
    if ((await card.locator(`${STATE}[aria-label="cancelled"]${SHOWN}`).count()) > 0) return 'failed';
    if ((await card.locator(`${STATE}[aria-label="error"]${SHOWN}`).count()) === 0) return undefined;
    return (await card.getByText(REJECTION_NOTICE).count()) > 0 ? 'rejected' : 'failed';
  }

  private async showsTool(expectation: ToolExpectation, stuck: string[]): Promise<boolean> {
    if (expectation.name === 'WaitFor') return this.showsWait(expectation);
    if (expectation.name === 'AskUserQuestion') {
      const asked = [...(await this.askedAnswers()).map((row) => row.question), ...(await this.unansweredQuestions())];
      return asked.includes(expectation.target);
    }
    const cards = this.toolCards(expectation);
    const output = wantedOutput(expectation);
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      if ((await this.toolStatus(card)) !== expectation.status) continue;
      if (output === undefined || (await this.showsOutput(card, output, stuck))) return true;
    }
    return false;
  }

  private turnWithSteered(): Locator {
    const sent = this.steered.reduce((rows, text) => rows.filter({ hasNotText: containing(text) }), this.userRows());
    return sent.last().locator('xpath=following-sibling::*[@role="listitem"]');
  }

  private async showsWait(expectation: WaitExpectation): Promise<boolean> {
    const cards = this.turnWithSteered()
      .locator(`${BLOCK}:not(${REPLY})`)
      .filter({ has: this.page.getByText(TOOL_LABELS.WaitFor, { exact: true }).and(this.page.locator(ON_A_CARD)) })
      .filter({ has: this.page.getByText(WAIT_SHOWS[waitOutcome(expectation) ?? 'running']) });
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      if ((await this.toolStatus(cards.nth(index))) === expectation.status) return true;
    }
    return false;
  }

  private async showsOutput(card: Locator, output: string, stuck: string[]): Promise<boolean> {
    const shown = await card.elementHandle({ timeout: TIMEOUTS.wait });
    const details = await shown?.$(`${DISCLOSURE}${SHOWN}`);
    if (shown === null || details === null || details === undefined) return false;
    let printed: string[] = [];
    try {
      await this.setDetails(details, true);
      printed = await this.outputPanelLines(shown);
    } catch (error) {
      stuck.push(reasonOf(error));
    }
    try {
      await this.setDetails(details, false);
    } catch (cause) {
      throw new Error(`expectTool() opened the details of a command to read its output and could not close them again: ${reasonOf(cause)}`, { cause });
    }
    return printed.includes(output);
  }

  private async setDetails(details: CardHandle, open: boolean): Promise<void> {
    const wanted = String(open);
    if ((await details.getAttribute('aria-expanded')) === wanted) return;
    await details.click({ timeout: TIMEOUTS.wait });
    await until(`the details of a command to ${open ? 'open' : 'close'}`, async () => ((await details.getAttribute('aria-expanded')) === wanted ? true : undefined), {
      timeoutMs: TIMEOUTS.wait,
    });
  }

  private async outputPanelLines(card: CardHandle): Promise<string[]> {
    const titles = await card.$$(`:text-is("${OUTPUT_PANEL}")${SHOWN}`);
    for (const title of titles.toReversed()) {
      const body = await title.$(PANEL_BODY);
      if (body !== null) return (await body.innerText()).split('\n').map((line) => line.trim());
    }
    return [];
  }

  private async unfoldGroups(scope: Locator = this.turnItems()): Promise<string[]> {
    const folded = scope
      .locator(`${FOLDED}${SHOWN}`)
      .filter({ has: this.page.locator(STATE) });
    const failures: string[] = [];
    for (const head of await folded.elementHandles()) {
      try {
        await head.click({ timeout: TIMEOUTS.wait });
      } catch (error) {
        failures.push(reasonOf(error));
      }
    }
    return failures;
  }

  private async askedAnswers(): Promise<{ readonly question: string; readonly answer: string }[]> {
    const receipts = this.turnItems()
      .locator(`${BLOCK}:not(${REPLY})`)
      .filter({ has: this.page.getByText(ASKED, { exact: true }).and(this.page.locator(SHOWN)) })
      .filter({ hasNot: this.page.locator('[inert]') });
    return (await receipts.allInnerTexts()).flatMap((text) => {
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const rows = lines.slice(lines.indexOf(ASKED) + 1);
      return rows.flatMap((question, index) => {
        const answer = rows[index + 1];
        return index % 2 === 0 && answer !== undefined ? [{ question, answer }] : [];
      });
    });
  }

  private async collectedAnswers(answer: string): Promise<number> {
    return (await this.askedAnswers()).filter((row) => row.answer === answer).length;
  }

  private async unansweredQuestions(): Promise<string[]> {
    const notes = this.turnItems()
      .locator(`${BLOCK}:not(${REPLY})`)
      .getByText(new RegExp(`${containing(UNANSWERED).source}$`))
      .and(this.page.locator(SHOWN));
    return (await notes.allInnerTexts()).map((note) => note.trim().slice(0, -UNANSWERED.length));
  }

  private questionCard(): Locator {
    return this.page.getByRole('button', { name: QUESTION_MAIN }).first().locator('xpath=ancestor::*').filter({ has: this.minimizeButton() }).last();
  }

  private async questionShown(): Promise<boolean> {
    return (await this.page.getByRole('button', { name: QUESTION_MAIN }).first().isVisible()) && (await this.questionCard().count()) > 0;
  }

  private async cardLines(card: Locator): Promise<string> {
    return (await card.innerText({ timeout: TIMEOUTS.wait }))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n');
  }

  private async pendingAsk(label: string): Promise<Ask | undefined> {
    let ask: Ask | undefined;
    const settled = await this.settle(label, async () => {
      ask = (await this.approvalShown()) ? 'approval' : (await this.questionShown()) ? 'question' : undefined;
      return ask !== undefined;
    });
    return settled === 'over' ? undefined : ask;
  }

  private async pendingApproval(verb: string): Promise<void> {
    const ask = await this.pendingAsk('an approval request');
    if (ask === undefined) throw new Error(`${verb} found no approval: the turn ended without asking for one.\n${await this.describe()}`);
    if (ask === 'question') throw new Error(`${verb} found no approval: ${QUESTION_PENDING}.\n${await this.describe()}`);
  }

  private async pendingQuestion(verb: string): Promise<Locator> {
    const ask = await this.pendingAsk('a question');
    if (ask === undefined) throw new Error(`${verb} found no question: the turn ended without asking one.\n${await this.describe()}`);
    if (ask === 'approval') throw new Error(`${verb} found no question: ${APPROVAL_PENDING}.\n${await this.describe()}`);
    return this.questionCard();
  }

  private async singleQuestion(verb: string): Promise<Locator> {
    const card = await this.pendingQuestion(verb);
    if ((await card.getByRole('button', { name: QUESTION_STEPS }).count()) > 0) {
      throw new Error(`${verb} answers one question at a time, but the model asked several at once; dismiss them with dismissQuestion().\n${await this.describe()}`);
    }
    return card;
  }

  private async submitAnswer(verb: string, card: Locator, answer: string, recorded: number): Promise<void> {
    const submit = await card.getByRole('button', { name: SUBMIT, exact: true }).elementHandle({ timeout: TIMEOUTS.wait });
    if (submit === null) throw new Error(`${verb} lost the question before it could submit the answer.\n${await this.describe()}`);
    await submit.click({ timeout: TIMEOUTS.wait });
    await submit.waitForElementState('hidden', { timeout: TIMEOUTS.server });
    await this.wait(`the conversation to record the answer ${JSON.stringify(answer)}`, async () => ((await this.collectedAnswers(answer)) > recorded ? true : undefined));
  }

  private async approvalShown(): Promise<boolean> {
    const approve = this.page.getByRole('button', { name: 'Approve', exact: true, disabled: false });
    const reject = this.page.getByRole('button', { name: 'Reject', exact: true, disabled: false });
    return (await approve.isVisible()) && (await reject.isVisible());
  }

  private async answerApproval(verb: string, button: Locator): Promise<void> {
    await this.pendingApproval(verb);
    const pressed = await button.elementHandle({ timeout: TIMEOUTS.wait });
    if (pressed === null) throw new Error(`${verb} lost the approval before it could answer it.\n${await this.describe()}`);
    await pressed.click({ timeout: TIMEOUTS.wait });
    await pressed.waitForElementState('hidden', { timeout: TIMEOUTS.server });
  }

  private async press(verb: string, name: string, control: Locator): Promise<void> {
    try {
      await control.click({ timeout: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`${verb} could not press ${name}: ${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
  }

  private settle(label: string, evidence: () => Promise<boolean>, watched: readonly Locator[] = []): Promise<'found' | 'over'> {
    let settled: string | undefined;
    return this.wait(label, async () => {
      if (await evidence()) return 'found';
      if (!(await this.idle())) {
        settled = undefined;
        return undefined;
      }
      const shown = (await Promise.all([this.turnItems(), ...watched].map((area) => area.allTextContents()))).flat().join('\n');
      if (settled === shown) return 'over';
      settled = shown;
      return undefined;
    });
  }

  private async wait<T>(label: string, check: () => Promise<T | undefined>): Promise<T> {
    let outcome: { readonly value: T } | { readonly closed: true };
    try {
      outcome = await until(
        label,
        async () => {
          if (this.page.isClosed()) return { closed: true as const };
          const value = await check();
          return value === undefined ? undefined : { value };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      throw new Error(`${reasonOf(cause)}\n${await this.describe()}`, { cause });
    }
    if ('closed' in outcome) throw new Error(`The page closed while the test waited for ${label}.`);
    return outcome.value;
  }
}
