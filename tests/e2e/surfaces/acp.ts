import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import {
  client,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type CreateTerminalRequest,
  type JsonRpcId,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
  type TerminalExitStatus,
  type TerminalOutputResponse,
  type ToolCallUpdate,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { killProcessTree, kimiCliCommand, kimiCliEnv, TestProcess, TIMEOUTS, until, type TestHome } from '@moonshot-ai/testkit/fixtures';

import { quote, TOOL_STATUS_WORDS } from '../support/steps';
import {
  APPROVAL_PENDING,
  describeApproval,
  describeTool,
  namesFile,
  PERMISSION_MODE_NAMES,
  QUESTION_PENDING,
  wantedOutput,
  type ApprovalExpectation,
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
import { productEnv } from './environment';
import { offlineStubs } from './offline';

const EDITOR_NAME = 'e2e-editor';
const WIRE_LOG_LINES = 4000;
const RECENT_WIRE_LINES = 20;
const LONGEST_FRAME_LINE = 300;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

const APPROVE_ONCE = 'approve_once';
const APPROVE_ALWAYS = 'approve_always';
const REJECT = 'reject';
const PERMISSION_OPTIONS: Readonly<Record<string, string>> = {
  [APPROVE_ONCE]: 'allow_once',
  [APPROVE_ALWAYS]: 'allow_always',
  [REJECT]: 'reject_once',
};
const SESSION_MODES: Readonly<Record<PermissionMode, string>> = { manual: 'default', yolo: 'yolo', auto: 'auto' };
const QUESTION_TOOL = 'AskUserQuestion';
const QUESTION_OPTION = /^q0_opt_\d+$/;
const QUESTION_SKIP = { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' } as const;
const REJECTION_NOTICE = 'was not run because the user rejected the approval request';
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;

const HANDLED_METHODS: ReadonlySet<string> = new Set([
  methods.client.session.update,
  methods.client.session.requestPermission,
  methods.client.fs.readTextFile,
  methods.client.fs.writeTextFile,
  methods.client.terminal.create,
  methods.client.terminal.output,
  methods.client.terminal.waitForExit,
  methods.client.terminal.kill,
  methods.client.terminal.release,
]);

interface Turn {
  readonly prompt: string;
  readonly updates: number;
  stopReason: StopReason | undefined;
  rejection: unknown;
  done: boolean;
}

interface PendingPermission {
  readonly params: RequestPermissionRequest;
  readonly requestId: JsonRpcId;
  answer(response: RequestPermissionResponse): void;
}

interface Terminal {
  readonly command: string | undefined;
  readonly log: string;
  readonly limit: number | undefined;
  readonly pid: number;
  readonly exited: Promise<TerminalExitStatus>;
  exit: TerminalExitStatus | undefined;
}

interface ToolView {
  readonly id: string;
  readonly terminals: string[];
  embedded: readonly string[];
  name: string;
  status: ToolStatus | undefined;
  path: string | undefined;
  command: string | undefined;
  questions: readonly string[];
  shownText: string;
}

type Entry = { readonly kind: 'reply'; text: string } | { readonly kind: 'tool'; readonly id: string };

interface WireEvent {
  readonly tool?: string;
  readonly settled?: boolean;
  readonly read?: string;
  readonly write?: string;
  readonly request?: JsonRpcId;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function toolsOf(updates: readonly SessionUpdate[]): ToolView[] {
  const tools = new Map<string, ToolView>();
  for (const update of updates) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
    const tool = tools.get(update.toolCallId) ?? {
      id: update.toolCallId,
      terminals: [],
      embedded: [],
      name: update.sessionUpdate === 'tool_call' ? update.title : '',
      status: update.sessionUpdate === 'tool_call' ? 'running' : undefined,
      path: undefined,
      command: undefined,
      questions: [],
      shownText: '',
    };
    tools.set(update.toolCallId, tool);
    const location = update.locations?.[0]?.path;
    if (location !== undefined) tool.path = location;
    const command = property(update.rawInput, 'command');
    if (typeof command === 'string') tool.command = command;
    const questions = questionsOf(update.rawInput);
    if (questions.length > 0) tool.questions = questions;
    const parts = update.content ?? [];
    const terminals = parts.flatMap((part) => (part.type === 'terminal' ? [part.terminalId] : []));
    for (const terminal of terminals) {
      if (!tool.terminals.includes(terminal)) tool.terminals.push(terminal);
    }
    if (update.content !== undefined && update.content !== null) tool.embedded = terminals;
    const text = parts.map((part) => (part.type === 'content' && part.content.type === 'text' ? part.content.text : '')).join('\n');
    if (update.content !== undefined && update.content !== null) tool.shownText = text;
    if (update.status === 'completed') tool.status = 'done';
    if (update.status === 'failed') tool.status = text.includes(REJECTION_NOTICE) ? 'rejected' : 'failed';
  }
  return [...tools.values()];
}

function questionsOf(rawInput: unknown): string[] {
  const questions = property(rawInput, 'questions');
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question: unknown) => {
    const text = property(question, 'question');
    return typeof text === 'string' ? [text] : [];
  });
}

function asksQuestion(pending: PendingPermission): boolean {
  return pending.params.toolCall.title === QUESTION_TOOL;
}

function entriesOf(updates: readonly SessionUpdate[]): Entry[] {
  const entries: Entry[] = [];
  let reply: { readonly kind: 'reply'; text: string } | undefined;
  for (const update of updates) {
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (reply === undefined) {
        reply = { kind: 'reply', text: '' };
        entries.push(reply);
      }
      reply.text += update.content.type === 'text' ? update.content.text : '';
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') {
      reply = undefined;
      const id = update.sessionUpdate === 'tool_call' ? update.toolCallId : undefined;
      if (id !== undefined && !entries.some((entry) => entry.kind === 'tool' && entry.id === id)) entries.push({ kind: 'tool', id });
    }
  }
  return entries;
}

function repliesOf(updates: readonly SessionUpdate[]): string[] {
  return entriesOf(updates).flatMap((entry) => (entry.kind === 'reply' ? [entry.text] : []));
}

function userTextsOf(updates: readonly SessionUpdate[]): string[] {
  const texts: string[] = [];
  let open = false;
  for (const update of updates) {
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = update.content.type === 'text' ? update.content.text : '';
      texts.push(`${open ? (texts.pop() ?? '') : ''}${text}`);
      open = true;
    } else {
      open = false;
    }
  }
  return texts;
}

function approvalTexts(toolCall: ToolCallUpdate): string[] {
  const parts = toolCall.content ?? [];
  const texts = [toolCall.title ?? '', ...parts.flatMap((part) => (part.type === 'content' && part.content.type === 'text' ? part.content.text.split('\n') : []))];
  return texts.map((text) => text.trim()).filter((text) => text !== '');
}

function approvalPaths(toolCall: ToolCallUpdate): string[] {
  const diffs = (toolCall.content ?? []).flatMap((part) => (part.type === 'diff' ? [part.path] : []));
  const locations = (toolCall.locations ?? []).map((location) => location.path);
  const inputs = ['path', 'file_path'].flatMap((key) => {
    const value = property(toolCall.rawInput, key);
    return typeof value === 'string' ? [value] : [];
  });
  return [...diffs, ...locations, ...inputs];
}

function approvalShows(toolCall: ToolCallUpdate, { name, target }: ApprovalExpectation, workspace: string): boolean {
  if (toolCall.title !== name) return false;
  const texts = approvalTexts(toolCall);
  if (name !== 'Bash') return [...texts, ...approvalPaths(toolCall)].some((shown) => namesFile(shown, target, workspace));
  return property(toolCall.rawInput, 'command') === target || texts.some((text) => text === target || text.endsWith(`: ${target}`));
}

function clipLine(line: string): string {
  return line.length > LONGEST_FRAME_LINE ? `${line.slice(0, LONGEST_FRAME_LINE)}…` : line;
}

function tailOf(bytes: Buffer, limit: number | undefined): { text: string; truncated: boolean } {
  if (limit === undefined || bytes.length <= limit) return { text: bytes.toString('utf8'), truncated: false };
  let start = bytes.length - limit;
  while (start < bytes.length && ((bytes[start] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) start += 1;
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

class AcpDriver implements SurfaceDriver<'acp'> {
  private readonly proc: TestProcess;
  private readonly home: TestHome;
  private readonly connection: ClientConnection;
  private readonly wire: string[] = [];
  private readonly timeline: WireEvent[] = [];
  private readonly garbage: string[] = [];
  private readonly unhandled: string[] = [];
  private readonly outside: string[] = [];
  private readonly updates: SessionUpdate[] = [];
  private readonly permissions: PendingPermission[] = [];
  private readonly spawned = new Map<string, Terminal>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly answered = new Set<JsonRpcId>();
  private readonly questionReplies = new Map<string, JsonRpcId>();
  private readonly served = new Set<JsonRpcId>();
  private droppedWireLines = 0;
  private framedWireLines = 0;
  private receivedUpdates = 0;
  private sentPrompts = 0;
  private prompts: string[] = [];
  private sessionStart = 0;
  private sessionId = '';
  private openedMode: string | undefined;
  private turn: Turn | undefined;

  constructor(proc: TestProcess, home: TestHome) {
    this.proc = proc;
    this.home = home;
    this.connection = client({ name: EDITOR_NAME })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.updates.push(params.update);
      })
      .onRequest(
        methods.client.session.requestPermission,
        ({ params, requestId }) =>
          new Promise<RequestPermissionResponse>((answer) => {
            this.permissions.push({ params, requestId, answer });
          }),
      )
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.readTextFile(params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => this.writeTextFile(params))
      .onRequest(methods.client.terminal.create, ({ params }) => this.createTerminal(params))
      .onRequest(methods.client.terminal.output, ({ params }) => this.terminalOutput(params.terminalId))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => this.terminal(params.terminalId).exited)
      .onRequest(methods.client.terminal.kill, ({ params }) => {
        this.killCommand(this.terminal(params.terminalId));
        return {};
      })
      .onRequest(methods.client.terminal.release, ({ params }) => {
        this.killCommand(this.terminal(params.terminalId));
        this.terminals.delete(params.terminalId);
        return {};
      })
      .connect(this.stream());
  }

  async open(resume: string | undefined): Promise<void> {
    const initialized = await this.response(
      'the agent to answer initialize',
      this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      }),
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`kimi acp answered initialize with protocol version ${String(initialized.protocolVersion)}; the editor speaks ${String(PROTOCOL_VERSION)}.`);
    }
    if (resume === undefined) {
      const session = await this.response(
        'the agent to create a session',
        this.connection.agent.request(methods.agent.session.new, { cwd: this.home.workspace, mcpServers: [] }),
      );
      this.sessionId = session.sessionId;
      this.openedMode = session.modes?.currentModeId;
      return;
    }
    if (initialized.agentCapabilities?.loadSession !== true) {
      throw new Error(`kimi acp does not offer session/load, so an editor cannot reopen session ${resume}.\n${this.describe()}`);
    }
    const loaded = await this.response(
      `the agent to load session ${resume}`,
      this.connection.agent.request(methods.agent.session.load, { sessionId: resume, cwd: this.home.workspace, mcpServers: [] }),
    );
    this.sessionId = resume;
    this.openedMode = loaded.modes?.currentModeId;
  }

  idle(): Promise<boolean> {
    return Promise.resolve(this.turnOver() && this.permissions.length === 0);
  }

  reopenState(): ReopenState {
    return { sessionId: this.sessionId };
  }

  async expectTranscript(text: string): Promise<void> {
    const count = (): number => this.conversation().reduce((sum, entry) => sum + entry.split(text).length - 1, 0);
    const state = await this.wait(`${JSON.stringify(text)} in the conversation`, () => {
      if (count() > 0) return 'shown' as const;
      return this.turnOver() ? ('over' as const) : undefined;
    });
    if (state === 'over') {
      throw new Error(`expectTranscript() did not find ${JSON.stringify(text)} in the conversation the editor holds:\n${this.conversation().join('\n')}`);
    }
    const times = count();
    if (times > 1) {
      throw new Error(`expectTranscript() found ${JSON.stringify(text)} ${times} times in the conversation; it must appear exactly once.\n${this.conversation().join('\n')}`);
    }
  }

  private conversation(): string[] {
    const updates = this.sessionUpdates();
    return [...userTextsOf(updates).map((text) => `user: ${text}`), ...this.prompts.map((text) => `user: ${text}`), ...repliesOf(updates).map((text) => `assistant: ${text}`)];
  }

  async send(text: string): Promise<void> {
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(`send() needs an idle product, but a turn is running or an approval is pending.\n${this.describe()}`);
    }
    const turn: Turn = { prompt: text, updates: this.updates.length, stopReason: undefined, rejection: undefined, done: false };
    this.turn = turn;
    this.prompts.push(text);
    const sent = this.sentPrompts;
    void this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }).then(
      (response) => {
        turn.stopReason = response.stopReason;
        turn.done = true;
      },
      (error: unknown) => {
        turn.rejection = error;
        turn.done = true;
      },
    );
    await this.wait('session/prompt to be sent to the agent', () => (this.sentPrompts > sent ? true : undefined));
  }

  approve(options?: ApproveOptions): Promise<void> {
    return this.answerPermission('approve()', options?.for === 'session' ? APPROVE_ALWAYS : APPROVE_ONCE);
  }

  reject(): Promise<void> {
    return this.answerPermission('reject()', REJECT);
  }

  async expectApproval(expectation: ApprovalExpectation): Promise<void> {
    const wanted = describeApproval(expectation);
    const pending = await this.wait(`an approval for ${wanted}`, () => this.permissions[0] ?? (this.turnOver() ? null : undefined));
    if (pending === null) {
      this.assertPromptValid();
      throw new Error(`expectApproval() found no approval for ${wanted}: the turn ended without asking for one.\n${this.describe()}`);
    }
    if (asksQuestion(pending)) throw new Error(`expectApproval() found no approval for ${wanted}: ${QUESTION_PENDING}.\n${this.describe()}`);
    const { toolCall } = pending.params;
    if (approvalShows(toolCall, expectation, this.home.workspace)) return;
    const shown = { title: toolCall.title, content: toolCall.content, rawInput: toolCall.rawInput, locations: toolCall.locations };
    throw new Error(`expectApproval() found an approval, but it does not show ${wanted}. The approval request shows:\n${JSON.stringify(shown, null, 2)}\n${this.describe()}`);
  }

  async answer(option: string): Promise<void> {
    const pending = await this.pendingQuestion('answer()');
    const asked = this.askedQuestions(pending);
    if (asked.length > 1) {
      throw new Error(`answer() answers one question at a time, but the model asked ${asked.length} at once; dismiss them with dismissQuestion().\n${this.describe()}`);
    }
    const offered = pending.params.options.filter((candidate) => candidate.optionId !== QUESTION_SKIP.optionId);
    const choice = offered.find((candidate) => candidate.name === option);
    if (choice === undefined) {
      throw new Error(`answer() found no option ${JSON.stringify(option)}. The question offers: ${offered.map((candidate) => JSON.stringify(candidate.name)).join(', ')}.\n${this.describe()}`);
    }
    await this.answerQuestion(pending, choice.optionId);
  }

  async dismissQuestion(): Promise<void> {
    await this.answerQuestion(await this.pendingQuestion('dismissQuestion()'), QUESTION_SKIP.optionId);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const name = PERMISSION_MODE_NAMES[mode];
    const modeId = SESSION_MODES[mode];
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(`setPermissionMode() needs an idle product, but a turn is running or an approval is pending.\n${this.describe()}`);
    }
    if (this.sessionMode() === modeId) {
      throw new Error(`setPermissionMode() asked for ${name}, but that is already the permission mode: the session is in mode ${modeId}.\n${this.describe()}`);
    }
    const mark = this.updates.length;
    await this.response(`the agent to switch the session to mode ${modeId}`, this.connection.agent.request(methods.agent.session.setMode, { sessionId: this.sessionId, modeId }));
    await this.wait('the agent to send every session/update it announced', () => (this.updates.length >= this.receivedUpdates ? true : undefined));
    const reported = this.updates.slice(mark).some((update) => update.sessionUpdate === 'current_mode_update' && update.currentModeId === modeId);
    if (!reported) {
      throw new Error(`setPermissionMode() switched the session to mode ${modeId}, but the agent never reported it with current_mode_update.\n${this.describe()}`);
    }
  }

  async newSession(): Promise<void> {
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(`newSession() needs an idle product, but a turn is running or an approval is pending.\n${this.describe()}`);
    }
    await this.wait('the agent to send every session/update it announced', () => (this.updates.length >= this.receivedUpdates ? true : undefined));
    const session = await this.response(
      'the agent to create a new session',
      this.connection.agent.request(methods.agent.session.new, { cwd: this.home.workspace, mcpServers: [] }),
    );
    if (session.sessionId === this.sessionId) {
      throw new Error(`newSession() asked for a new session, but the agent answered with the current one, ${session.sessionId}.\n${this.describe()}`);
    }
    this.sessionId = session.sessionId;
    this.openedMode = session.modes?.currentModeId;
    this.sessionStart = this.updates.length;
    this.prompts = [];
    this.turn = undefined;
  }

  async stop(): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || turn.done) throw new Error(`stop() needs a running turn, but the product is idle.\n${this.describe()}`);
    if (this.permissions.some(asksQuestion)) {
      throw new Error(
        `stop() cannot stop the turn: ${QUESTION_PENDING}. The terminal UI, Desktop and Web cannot stop a turn without answering its question, so the editor does not either.\n${this.describe()}`,
      );
    }
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
    const unanswered: PendingPermission[] = [];
    const cancelPending = (): void => {
      for (const pending of this.permissions.splice(0)) {
        pending.answer({ outcome: { outcome: 'cancelled' } });
        unanswered.push(pending);
      }
    };
    cancelPending();
    await this.wait('the turn to stop', () => {
      cancelPending();
      return this.turnOver() ? true : undefined;
    });
    await this.wait('the editor to answer the approval requests of the stopped turn', () =>
      unanswered.every((pending) => this.answered.has(pending.requestId)) ? true : undefined,
    );
    this.assertPromptValid();
    if (turn.stopReason !== 'cancelled') {
      throw new Error(`stop() did not interrupt the turn: it ended with stop reason ${String(turn.stopReason)}.\n${this.describe()}`);
    }
  }

  async waitIdle(): Promise<void> {
    const state = await this.wait('the turn to end', () => {
      const pending = this.permissions[0];
      if (pending !== undefined) return asksQuestion(pending) ? ('question' as const) : ('approval' as const);
      return this.turnOver() ? ('idle' as const) : undefined;
    });
    if (state === 'question') throw new Error(`waitIdle() found the turn waiting: ${QUESTION_PENDING}.\n${this.describe()}`);
    if (state === 'approval') {
      throw new Error(`waitIdle() found a pending approval; answer it with approve() or reject() first.\n${this.describe()}`);
    }
    this.assertPromptValid();
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = describeTool(expectation);
    const state = await this.wait(`the tool ${wanted}`, () => {
      if (this.turnOver()) return expectation.status !== 'running' && this.shownTools(expectation).length > 0 ? ('shown' as const) : ('over' as const);
      if (this.shownTools(expectation).length > 0) return 'shown' as const;
      return expectation.status === 'running' && this.permissions.length > 0 ? ('approval' as const) : undefined;
    });
    if (state === 'approval') {
      throw new Error(`expectTool() cannot find a running command while an approval is pending; answer it with approve() or reject() first.\n${this.describe()}`);
    }
    if (state === 'over') {
      this.assertPromptValid();
      throw new Error(`expectTool() did not find ${wanted}. The turn ended and it shows:\n${this.describe()}`);
    }
    for (const tool of this.shownTools(expectation)) {
      const missing = this.missingEditorEvidence(tool, expectation);
      if (missing !== undefined) throw new Error(`expectTool() found ${wanted}, but ${missing}.\n${this.describe()}`);
    }
  }

  async expectReply(text: string): Promise<void> {
    const state = await this.wait(`the reply ${JSON.stringify(text)}`, () => {
      if (repliesOf(this.turnUpdates()).some((reply) => reply.includes(text))) return 'shown' as const;
      return this.turnOver() ? ('over' as const) : undefined;
    });
    if (state === 'over') {
      this.assertPromptValid();
      throw new Error(`expectReply() did not find ${JSON.stringify(text)} in an assistant reply. The turn ended and it shows:\n${this.describe()}`);
    }
    const times = repliesOf(this.turnUpdates()).reduce((sum, reply) => sum + reply.split(text).length - 1, 0);
    if (times > 1) {
      throw new Error(`expectReply() found ${JSON.stringify(text)} ${times} times in the replies of this turn; it must appear exactly once.\n${this.describe()}`);
    }
  }

  async expectError(text: string): Promise<void> {
    await this.wait(`the turn to fail with ${JSON.stringify(text)}`, () => (this.turnOver() ? true : undefined));
    this.assertPromptValid();
    const turn = this.turn;
    if (turn?.rejection === undefined) {
      const ended = turn === undefined ? 'no turn has started' : `the latest turn ended with stop reason ${String(turn.stopReason)}`;
      throw new Error(`expectError() found no failure: ${ended}, and session/prompt did not fail.\n${this.describe()}`);
    }
    const message = property(turn.rejection, 'message');
    if (typeof message === 'string' && message.includes(text)) return;
    throw new Error(`expectError() found the latest turn failed, but not with ${JSON.stringify(text)}; session/prompt failed with: ${reasonOf(turn.rejection)}\n${this.describe()}`);
  }

  expectAbsent(text: string): Promise<void> {
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(
        `expectAbsent() needs an idle product, but a turn is running or an approval is pending: until the turn ends, text that has not appeared may still appear. Call waitIdle() first.\n${this.describe()}`,
      );
    }
    const times = repliesOf(this.turnUpdates()).reduce((sum, reply) => sum + reply.split(text).length - 1, 0);
    if (times > 0) throw new Error(`expectAbsent() found ${JSON.stringify(text)} ${times} time(s) in the replies of the latest turn.\n${this.describe()}`);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(`The scenario ended while a turn was running or an approval was pending; end it with waitIdle().\n${this.describe()}`);
    }
    if (this.proc.exit() !== undefined) throw new Error(`kimi acp exited before the scenario closed it.\n${this.describe()}`);
    this.proc.stdin.end();
    let exit;
    try {
      exit = await until('kimi acp to exit after its input closed', () => this.proc.exit(), { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`kimi acp did not exit after its input closed.\n${this.describe()}`, { cause });
    }
    const running = [...this.spawned.values()].filter((terminal) => terminal.exit === undefined);
    for (const terminal of this.spawned.values()) this.killCommand(terminal);
    const problems = [
      ...(exit.code === 0 ? [] : [`kimi acp exited with code ${String(exit.code)} and signal ${String(exit.signal)}.`]),
      ...(this.garbage.length === 0 ? [] : [`kimi acp wrote ${this.garbage.length} line(s) to stdout that are not JSON-RPC messages:\n${this.garbage.join('\n')}`]),
      ...(this.unhandled.length === 0 ? [] : [`The agent called method(s) the editor does not implement: ${[...new Set(this.unhandled)].join(', ')}.`]),
      ...(this.outside.length === 0 ? [] : [`The agent asked the editor to write outside the test home: ${this.outside.join(', ')}.`]),
      ...(running.length === 0 ? [] : [`${running.length} terminal command(s) were still running when the scenario ended.`]),
    ];
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\n${this.describe()}`);
  }

  async kill(): Promise<void> {
    for (const terminal of this.spawned.values()) this.killCommand(terminal);
    for (const pending of this.permissions.splice(0)) pending.answer({ outcome: { outcome: 'cancelled' } });
    if (this.proc.exit() === undefined) await this.proc.forceKill();
  }

  networkViolations(): Promise<readonly string[]> {
    return this.proc.networkViolations();
  }

  frame(): Promise<Frame> {
    const recorded = this.droppedWireLines + this.wire.length;
    const fresh = Math.min(recorded - this.framedWireLines, this.wire.length);
    this.framedWireLines = recorded;
    const messages = fresh === 0 ? ['（没有）'] : this.wire.slice(-fresh).map(clipLine);
    return Promise.resolve({
      kind: 'text',
      text: [...this.editorView(), '', '上一帧之后，编辑器和 agent 之间新增的 JSON-RPC 消息（-> 编辑器发出，<- agent 发来）：', ...messages].join('\n'),
    });
  }

  diagnostics(): Promise<readonly Diagnostic[]> {
    const exit = this.proc.exit();
    const dropped = this.droppedWireLines === 0 ? [] : [`(${this.droppedWireLines} earlier message(s) are not kept)`];
    return Promise.resolve([
      { name: 'acp-messages', body: [...dropped, ...this.wire].join('\n') },
      {
        name: 'acp-session',
        body: [
          exit === undefined ? 'kimi acp is still running' : `kimi acp exited with code ${String(exit.code)} and signal ${String(exit.signal)}`,
          `stdout lines that are not JSON-RPC: ${JSON.stringify(this.garbage)}`,
          `methods without a handler: ${JSON.stringify(this.unhandled)}`,
          `stderr:\n${this.proc.stderrTail() === '' ? '(empty)' : this.proc.stderrTail()}`,
        ].join('\n'),
      },
    ]);
  }

  private stream(): { readable: ReadableStream<AnyMessage>; writable: WritableStream<AnyMessage> } {
    let partial = '';
    const readable = new ReadableStream<AnyMessage>({
      start: (controller) => {
        this.proc.onOutput((text) => {
          const lines = (partial + text).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            const message = this.received(line);
            if (message !== undefined) controller.enqueue(message);
          }
        });
        void this.proc.closed.then(() => {
          if (partial.trim() !== '') this.garbage.push(partial);
          controller.close();
        });
      },
    });
    const writable = new WritableStream<AnyMessage>({
      write: (message) => {
        const line = JSON.stringify(message);
        this.record(`-> ${line}`);
        if ('method' in message && message.method === methods.agent.session.prompt) this.sentPrompts += 1;
        if (!('method' in message)) {
          this.answered.add(message.id);
          if ('result' in message) this.served.add(message.id);
        }
        this.proc.stdin.write(`${line}\n`);
      },
    });
    return { readable, writable };
  }

  private received(line: string): AnyMessage | undefined {
    if (line.trim() === '') return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    if (typeof message !== 'object' || message === null || !('jsonrpc' in message)) {
      this.garbage.push(line);
      return undefined;
    }
    this.record(`<- ${line}`);
    const method = property(message, 'method');
    if (typeof method === 'string') {
      if (method === methods.client.session.update) this.receivedUpdates += 1;
      if (!HANDLED_METHODS.has(method)) this.unhandled.push(method);
      this.trace(method, property(message, 'params'), property(message, 'id'));
    }
    return message as AnyMessage;
  }

  private trace(method: string, params: unknown, id: unknown): void {
    if (method === methods.client.session.update) {
      const update = property(params, 'update');
      const tool = property(update, 'toolCallId');
      const status = property(update, 'status');
      if (typeof tool === 'string') this.timeline.push({ tool, settled: status === 'completed' || status === 'failed' });
      return;
    }
    const path = property(params, 'path');
    if (typeof path !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return;
    if (method === methods.client.fs.readTextFile) this.timeline.push({ read: normalize(path), request: id });
    if (method === methods.client.fs.writeTextFile) this.timeline.push({ write: normalize(path), request: id });
  }

  private record(line: string): void {
    this.wire.push(line);
    if (this.wire.length <= WIRE_LOG_LINES) return;
    this.wire.shift();
    this.droppedWireLines += 1;
  }

  private async readTextFile({ path, line, limit }: ReadTextFileRequest): Promise<{ content: string }> {
    if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, `fs/read_text_file needs an absolute path, got ${path}`);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw RequestError.resourceNotFound(path);
      throw RequestError.internalError(undefined, reasonOf(error));
    }
    const first = Math.max(line ?? 1, 1) - 1;
    const last = limit === null || limit === undefined ? undefined : first + limit;
    return { content: content.split('\n').slice(first, last).join('\n') };
  }

  private async writeTextFile({ path, content }: WriteTextFileRequest): Promise<Record<string, never>> {
    const target = normalize(path);
    if (!target.startsWith(`${this.home.root}${sep}`)) {
      this.outside.push(target);
      throw RequestError.invalidParams(undefined, `the editor only writes inside the test home, not ${target}`);
    }
    try {
      await writeFile(target, content);
    } catch (error) {
      throw RequestError.internalError(undefined, reasonOf(error));
    }
    return {};
  }

  private async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const terminalId = `terminal-${this.spawned.size + 1}`;
    const log = join(this.home.root, `${terminalId}.log`);
    const requested = Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value]));
    const output = await open(log, 'w');
    let child: ChildProcess;
    let exited: Promise<TerminalExitStatus>;
    try {
      child = spawn(params.command, params.args ?? [], {
        cwd: params.cwd ?? this.home.workspace,
        env: { ...kimiCliEnv(this.home), ...requested },
        stdio: ['ignore', output.fd, output.fd],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      exited = new Promise((resolve) => {
        child.once('exit', (exitCode, signal) => {
          resolve({ exitCode, signal });
        });
      });
      await this.started(child);
    } catch (error) {
      throw RequestError.internalError(undefined, `the editor could not start ${params.command}: ${reasonOf(error)}`);
    } finally {
      await output.close();
    }
    if (child.pid === undefined) throw RequestError.internalError(undefined, `the editor could not start ${params.command}: no process id`);
    const terminal: Terminal = { command: params.args?.[1], log, limit: params.outputByteLimit ?? undefined, pid: child.pid, exited, exit: undefined };
    void exited.then((status) => {
      terminal.exit = status;
    });
    this.spawned.set(terminalId, terminal);
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  private started(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        resolve();
      });
    });
  }

  private terminal(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) throw RequestError.invalidParams(undefined, `the editor has no terminal ${terminalId}`);
    return terminal;
  }

  private async terminalOutput(terminalId: string): Promise<TerminalOutputResponse> {
    const terminal = this.terminal(terminalId);
    const { text, truncated } = tailOf(await readFile(terminal.log), terminal.limit);
    return { output: text, truncated, ...(terminal.exit === undefined ? {} : { exitStatus: terminal.exit }) };
  }

  private killCommand(terminal: Terminal): void {
    if (terminal.exit === undefined) {
      killProcessTree(terminal.pid);
      return;
    }
    if (process.platform === 'win32') return;
    try {
      process.kill(-terminal.pid, 'SIGKILL');
    } catch {
      return;
    }
  }

  private async answerPermission(verb: string, optionId: string): Promise<void> {
    const pending = await this.wait('an approval request', () => this.permissions[0] ?? (this.turnOver() ? null : undefined));
    if (pending === null) {
      this.assertPromptValid();
      throw new Error(`${verb} found no approval: the turn ended without asking for one.\n${this.describe()}`);
    }
    if (asksQuestion(pending)) throw new Error(`${verb} found no approval: ${QUESTION_PENDING}.\n${this.describe()}`);
    const offered = Object.fromEntries(pending.params.options.map((option) => [option.optionId, option.kind]));
    const expected = Object.entries(PERMISSION_OPTIONS);
    if (Object.keys(offered).length !== expected.length || expected.some(([id, kind]) => offered[id] !== kind)) {
      throw new Error(`${verb} got an approval request with unexpected options: ${JSON.stringify(pending.params.options)}`);
    }
    this.permissions.shift();
    pending.answer({ outcome: { outcome: 'selected', optionId } });
    await this.wait('the answer to the approval request to be sent', () => (this.answered.has(pending.requestId) ? true : undefined));
  }

  private async pendingQuestion(verb: string): Promise<PendingPermission> {
    const pending = await this.wait('a question', () => this.permissions[0] ?? (this.turnOver() ? null : undefined));
    if (pending === null) {
      this.assertPromptValid();
      throw new Error(`${verb} found no question: the turn ended without asking one.\n${this.describe()}`);
    }
    if (!asksQuestion(pending)) throw new Error(`${verb} found no question: ${APPROVAL_PENDING}.\n${this.describe()}`);
    const { options } = pending.params;
    const answers = options.slice(0, -1);
    const skip = options.at(-1);
    const shaped =
      answers.length > 0 &&
      answers.every((option) => QUESTION_OPTION.test(option.optionId) && option.kind === 'allow_once') &&
      skip?.optionId === QUESTION_SKIP.optionId &&
      skip.name === QUESTION_SKIP.name &&
      skip.kind === QUESTION_SKIP.kind;
    if (!shaped) throw new Error(`${verb} got a question with unexpected options: ${JSON.stringify(options)}\n${this.describe()}`);
    return pending;
  }

  private askedQuestions(pending: PendingPermission): readonly string[] {
    return toolsOf(this.turnUpdates()).find((tool) => tool.id === pending.params.toolCall.toolCallId)?.questions ?? [];
  }

  private async answerQuestion(pending: PendingPermission, optionId: string): Promise<void> {
    this.permissions.shift();
    this.questionReplies.set(pending.params.toolCall.toolCallId, pending.requestId);
    pending.answer({ outcome: { outcome: 'selected', optionId } });
    await this.wait('the answer to the question to be sent', () => (this.answered.has(pending.requestId) ? true : undefined));
  }

  private missingEditorEvidence(tool: ToolView, expectation: ToolExpectation): string | undefined {
    if (expectation.status === 'rejected' || this.replayedTurn()) return undefined;
    if (expectation.name === 'AskUserQuestion') {
      const reply = this.questionReplies.get(tool.id);
      return reply !== undefined && this.served.has(reply) ? undefined : 'the editor never answered a question for it';
    }
    if (expectation.name === 'Bash') return this.missingTerminalEvidence(tool, expectation);
    if (expectation.status !== 'done') return undefined;
    const path = normalize(join(this.home.workspace, expectation.target));
    const first = this.timeline.findIndex((event) => event.tool === tool.id);
    const last = this.timeline.findLastIndex((event) => event.tool === tool.id && event.settled === true);
    const during = this.timeline.slice(first, last + 1).filter((event) => event.request !== undefined && this.served.has(event.request));
    if (expectation.name === 'Read') {
      return during.some((event) => event.read === path) ? undefined : 'the agent did not get the file from the editor with fs/read_text_file while that tool ran';
    }
    return during.some((event) => event.write === path) ? undefined : 'the agent did not send the file to the editor with fs/write_text_file while that tool ran';
  }

  private missingTerminalEvidence(tool: ToolView, expectation: ToolExpectation): string | undefined {
    const foreign = tool.terminals.filter((id) => !this.spawned.has(id));
    if (foreign.length > 0) return `it refers to terminal(s) the editor never created: ${foreign.join(', ')}`;
    if (expectation.status !== 'done') return undefined;
    const ran = tool.terminals.flatMap((id) => this.spawned.get(id) ?? []);
    if (ran.length === 0) return 'the agent never asked the editor for a terminal to run it';
    const finished = ran.some((terminal) => terminal.command?.endsWith(expectation.target) === true && terminal.exit?.exitCode === 0);
    return finished ? undefined : 'no terminal the editor ran for it ended that command with exit code 0';
  }

  private shownTools(expectation: ToolExpectation): ToolView[] {
    const output = wantedOutput(expectation);
    return toolsOf(this.turnUpdates()).filter((tool) => {
      if (tool.name !== expectation.name || tool.status !== expectation.status) return false;
      if (expectation.name === 'AskUserQuestion') return tool.questions.includes(expectation.target);
      if (expectation.name !== 'Bash') return tool.path !== undefined && this.workspacePath(tool.path) === expectation.target;
      if (tool.command !== expectation.target || output === undefined) return tool.command === expectation.target;
      return this.replayedTurn() ? tool.shownText.split('\n').some((line) => line.trim() === output) : this.embedsOutput(tool, output);
    });
  }

  private embedsOutput(tool: ToolView, output: string): boolean {
    return tool.embedded.some((id) => {
      const terminal = this.spawned.get(id);
      if (terminal?.command === undefined || tool.command === undefined || !terminal.command.endsWith(tool.command)) return false;
      return readFileSync(terminal.log, 'utf8')
        .split('\n')
        .some((line) => line.trim() === output);
    });
  }

  private workspacePath(path: string): string {
    return relative(this.home.workspace, normalize(path)).split(sep).join('/');
  }

  private sessionMode(): string | undefined {
    const reported = this.sessionUpdates().findLast((update) => update.sessionUpdate === 'current_mode_update');
    return reported?.sessionUpdate === 'current_mode_update' ? reported.currentModeId : this.openedMode;
  }

  private turnUpdates(): readonly SessionUpdate[] {
    if (this.turn !== undefined) return this.updates.slice(this.turn.updates);
    const updates = this.sessionUpdates();
    const lastUserMessage = updates.findLastIndex((update) => update.sessionUpdate === 'user_message_chunk');
    return lastUserMessage < 0 ? [] : updates.slice(lastUserMessage + 1);
  }

  private sessionUpdates(): readonly SessionUpdate[] {
    return this.updates.slice(this.sessionStart);
  }

  private replayedTurn(): boolean {
    return this.turn === undefined;
  }

  private turnOver(): boolean {
    return this.turn === undefined || (this.turn.done && this.updates.length >= this.receivedUpdates);
  }

  private assertPromptValid(): void {
    const rejection = this.turn?.rejection;
    if (rejection === undefined) return;
    const code = property(rejection, 'code');
    if (typeof code === 'number' && code !== INVALID_REQUEST && code !== INVALID_PARAMS) return;
    throw new Error(`The agent refused session/prompt as invalid: ${reasonOf(rejection)}\n${this.describe()}`);
  }

  private async response<T>(label: string, request: Promise<T>): Promise<T> {
    const settled: { done: boolean; value?: T; error?: unknown } = { done: false };
    void request.then(
      (value) => {
        settled.value = value;
        settled.done = true;
      },
      (error: unknown) => {
        settled.error = error;
        settled.done = true;
      },
    );
    await this.wait(label, () => (settled.done ? true : undefined));
    if (settled.error !== undefined) throw new Error(`The test waited for ${label}, but the request failed: ${reasonOf(settled.error)}\n${this.describe()}`);
    return settled.value as T;
  }

  private async wait<T>(label: string, check: () => T | undefined): Promise<T> {
    let outcome: { readonly value: T } | { readonly halted: true };
    try {
      outcome = await until(
        label,
        () => {
          const value = check();
          if (value !== undefined) return { value };
          return this.proc.exit() === undefined ? undefined : { halted: true as const };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      const unparsed = this.receivedUpdates - this.updates.length;
      const schema =
        this.turn?.done === true && unparsed > 0
          ? `\n${unparsed} session/update notification(s) did not pass the SDK's schema, so the editor never saw the turn as finished.`
          : '';
      throw new Error(`${reasonOf(cause)}${schema}\n${this.describe()}`, { cause });
    }
    if ('halted' in outcome) throw new Error(`kimi acp exited while the test waited for ${label}.\n${this.describe()}`);
    return outcome.value;
  }

  private editorView(): string[] {
    const turn = this.turn;
    if (turn === undefined) return ['ACP 没有界面。还没有开始回合：用户还没发过提示词。'];
    const updates = this.turnUpdates();
    const tools = new Map(toolsOf(updates).map((tool) => [tool.id, tool]));
    const named = (tool: ToolView): string => {
      const target = tool.command ?? (tool.path === undefined ? tool.questions[0] : this.workspacePath(tool.path));
      return target === undefined ? tool.name : `${tool.name}${quote(target)}`;
    };
    const describeEntry = (entry: Entry): string => {
      if (entry.kind === 'reply') return `回复：${entry.text}`;
      const tool = tools.get(entry.id);
      if (tool === undefined) return `工具：${entry.id}`;
      return `工具：${named(tool)}，${tool.status === undefined ? '状态未知' : TOOL_STATUS_WORDS[tool.status]}`;
    };
    const approvals = this.permissions.map((pending) => {
      const tool = tools.get(pending.params.toolCall.toolCallId);
      return `等用户回答的${asksQuestion(pending) ? '问题' : '审批'}：${tool === undefined ? (pending.params.toolCall.title ?? pending.params.toolCall.toolCallId) : named(tool)}`;
    });
    const state = !turn.done ? '进行中' : turn.rejection === undefined ? `已结束（stopReason: ${String(turn.stopReason)}）` : `失败：${reasonOf(turn.rejection)}`;
    return ['ACP 没有界面。下面是编辑器这一侧在本回合收到的内容：', `用户：${turn.prompt}`, ...entriesOf(updates).map(describeEntry), ...approvals, `回合：${state}`];
  }

  private describe(): string {
    const updates = this.turnUpdates();
    const tools = toolsOf(updates).map((tool) => {
      const target = tool.command ?? (tool.path === undefined ? (tool.questions[0] ?? '(no target yet)') : this.workspacePath(tool.path));
      return `- ${tool.name} on ${JSON.stringify(target)}: ${tool.status ?? 'not finished'}`;
    });
    const rejection = this.turn?.rejection;
    return [
      `Tools in this turn:\n${tools.length === 0 ? '(none)' : tools.join('\n')}`,
      `Replies in this turn: ${JSON.stringify(repliesOf(updates))}`,
      ...(rejection === undefined ? [] : [`session/prompt failed: ${reasonOf(rejection)}`]),
      `Pending approvals and questions: ${this.permissions.length}`,
      `session/update notifications: ${this.receivedUpdates} received, ${this.updates.length} passed the SDK's schema`,
      `Last messages:\n${this.wire.slice(-RECENT_WIRE_LINES).join('\n')}`,
      `stderr:\n${this.proc.stderrTail() === '' ? '(empty)' : this.proc.stderrTail()}`,
    ].join('\n');
  }
}

export async function startAcp({ home, reopen }: SurfaceLaunch): Promise<SurfaceDriver<'acp'>> {
  const proc = TestProcess.start({
    label: 'kimi acp',
    command: kimiCliCommand(),
    args: ['acp'],
    cwd: home.workspace,
    env: productEnv(home),
    logDir: home.root,
    stdin: true,
    fetchStubs: offlineStubs(),
  });
  const driver = new AcpDriver(proc, home);
  try {
    await driver.open(reopen?.state.sessionId);
  } catch (error) {
    await driver.kill();
    throw error;
  }
  return driver;
}
