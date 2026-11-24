import { spawn, type ChildProcess } from 'node:child_process';
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
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { kimiCliCommand, kimiCliEnv, TestProcess, TIMEOUTS, until, type TestHome } from '@moonshot-ai/testkit/fixtures';

import type { Diagnostic, SurfaceDriver, SurfaceLaunch, ToolExpectation, ToolStatus } from '../support/verbs';
import { offlineStubs } from './offline';

const EDITOR_NAME = 'e2e-editor';
const WIRE_LOG_LINES = 4000;
const RECENT_WIRE_LINES = 20;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

const APPROVE_ONCE = 'approve_once';
const REJECT = 'reject';
const PERMISSION_OPTIONS: Readonly<Record<string, string>> = {
  [APPROVE_ONCE]: 'allow_once',
  approve_always: 'allow_always',
  [REJECT]: 'reject_once',
};
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
  name: string;
  status: ToolStatus | undefined;
  path: string | undefined;
  command: string | undefined;
}

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
      name: update.sessionUpdate === 'tool_call' ? update.title : '',
      status: undefined,
      path: undefined,
      command: undefined,
    };
    tools.set(update.toolCallId, tool);
    const location = update.locations?.[0]?.path;
    if (location !== undefined) tool.path = location;
    const command = property(update.rawInput, 'command');
    if (typeof command === 'string') tool.command = command;
    const parts = update.content ?? [];
    for (const part of parts) {
      if (part.type === 'terminal' && !tool.terminals.includes(part.terminalId)) tool.terminals.push(part.terminalId);
    }
    const text = parts.map((part) => (part.type === 'content' && part.content.type === 'text' ? part.content.text : '')).join('\n');
    if (update.status === 'completed') tool.status = 'done';
    if (update.status === 'failed') tool.status = text.includes(REJECTION_NOTICE) ? 'rejected' : 'failed';
  }
  return [...tools.values()];
}

function repliesOf(updates: readonly SessionUpdate[]): string[] {
  const replies: string[] = [];
  let open = false;
  for (const update of updates) {
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content.type === 'text' ? update.content.text : '';
      replies.push(`${open ? (replies.pop() ?? '') : ''}${text}`);
      open = true;
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'agent_thought_chunk') {
      open = false;
    }
  }
  return replies;
}

function tailOf(bytes: Buffer, limit: number | undefined): { text: string; truncated: boolean } {
  if (limit === undefined || bytes.length <= limit) return { text: bytes.toString('utf8'), truncated: false };
  let start = bytes.length - limit;
  while (start < bytes.length && ((bytes[start] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) start += 1;
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

function exitStatusOf(child: ChildProcess): Promise<TerminalExitStatus> {
  return new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

class AcpDriver implements SurfaceDriver {
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
  private readonly served = new Set<JsonRpcId>();
  private droppedWireLines = 0;
  private receivedUpdates = 0;
  private sentPrompts = 0;
  private sessionId = '';
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

  async open(): Promise<void> {
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
    const session = await this.response(
      'the agent to create a session',
      this.connection.agent.request(methods.agent.session.new, { cwd: this.home.workspace, mcpServers: [] }),
    );
    this.sessionId = session.sessionId;
  }

  async send(text: string): Promise<void> {
    if (!this.turnOver() || this.permissions.length > 0) {
      throw new Error(`send() needs an idle product, but a turn is running or an approval is pending.\n${this.describe()}`);
    }
    const turn: Turn = { updates: this.updates.length, stopReason: undefined, rejection: undefined, done: false };
    this.turn = turn;
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

  approve(): Promise<void> {
    return this.answerPermission('approve()', APPROVE_ONCE);
  }

  reject(): Promise<void> {
    return this.answerPermission('reject()', REJECT);
  }

  async stop(): Promise<void> {
    if (this.permissions.length > 0) {
      throw new Error(`stop() cannot stop a turn while an approval is pending; answer it first.\n${this.describe()}`);
    }
    const turn = this.turn;
    if (turn === undefined || turn.done) throw new Error(`stop() needs a running turn, but the product is idle.\n${this.describe()}`);
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
    await this.wait('the turn to stop', () => {
      for (const pending of this.permissions.splice(0)) pending.answer({ outcome: { outcome: 'cancelled' } });
      return this.turnOver() ? true : undefined;
    });
    this.assertPromptValid();
    if (turn.stopReason !== 'cancelled') {
      throw new Error(`stop() did not interrupt the turn: it ended with stop reason ${String(turn.stopReason)}.\n${this.describe()}`);
    }
  }

  async waitIdle(): Promise<void> {
    const state = await this.wait('the turn to end', () => {
      if (this.permissions.length > 0) return 'approval' as const;
      return this.turnOver() ? ('idle' as const) : undefined;
    });
    if (state === 'approval') {
      throw new Error(`waitIdle() found a pending approval; answer it with approve() or reject() first.\n${this.describe()}`);
    }
    this.assertPromptValid();
  }

  async expectTool(expectation: ToolExpectation): Promise<void> {
    const wanted = `${expectation.name} on ${JSON.stringify(expectation.target)} with status ${expectation.status}`;
    const state = await this.wait(`the tool ${wanted}`, () => {
      if (this.shownTools(expectation).length > 0) return 'shown' as const;
      return this.turnOver() ? ('over' as const) : undefined;
    });
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
        detached: true,
      });
      exited = exitStatusOf(child);
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
    const offered = Object.fromEntries(pending.params.options.map((option) => [option.optionId, option.kind]));
    const expected = Object.entries(PERMISSION_OPTIONS);
    if (Object.keys(offered).length !== expected.length || expected.some(([id, kind]) => offered[id] !== kind)) {
      throw new Error(`${verb} got an approval request with unexpected options: ${JSON.stringify(pending.params.options)}`);
    }
    this.permissions.shift();
    pending.answer({ outcome: { outcome: 'selected', optionId } });
    await this.wait('the answer to the approval request to be sent', () => (this.answered.has(pending.requestId) ? true : undefined));
  }

  private missingEditorEvidence(tool: ToolView, expectation: ToolExpectation): string | undefined {
    if (expectation.status === 'rejected') return undefined;
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
    return toolsOf(this.turnUpdates()).filter((tool) => {
      if (tool.name !== expectation.name || tool.status !== expectation.status) return false;
      if (expectation.name === 'Bash') return tool.command === expectation.target;
      return tool.path !== undefined && this.workspacePath(tool.path) === expectation.target;
    });
  }

  private workspacePath(path: string): string {
    return relative(this.home.workspace, normalize(path)).split(sep).join('/');
  }

  private turnUpdates(): readonly SessionUpdate[] {
    return this.turn === undefined ? [] : this.updates.slice(this.turn.updates);
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

  private describe(): string {
    const updates = this.turnUpdates();
    const tools = toolsOf(updates).map((tool) => {
      const target = tool.command ?? (tool.path === undefined ? '(no target yet)' : this.workspacePath(tool.path));
      return `- ${tool.name} on ${JSON.stringify(target)}: ${tool.status ?? 'not finished'}`;
    });
    const rejection = this.turn?.rejection;
    return [
      `Tools in this turn:\n${tools.length === 0 ? '(none)' : tools.join('\n')}`,
      `Replies in this turn: ${JSON.stringify(repliesOf(updates))}`,
      ...(rejection === undefined ? [] : [`session/prompt failed: ${reasonOf(rejection)}`]),
      `Pending approvals: ${this.permissions.length}`,
      `session/update notifications: ${this.receivedUpdates} received, ${this.updates.length} passed the SDK's schema`,
      `Last messages:\n${this.wire.slice(-RECENT_WIRE_LINES).join('\n')}`,
      `stderr:\n${this.proc.stderrTail() === '' ? '(empty)' : this.proc.stderrTail()}`,
    ].join('\n');
  }
}

export async function startAcp({ home }: SurfaceLaunch): Promise<SurfaceDriver> {
  if (process.platform === 'win32') throw new Error('The ACP surface runs terminal commands in process groups; Windows is not supported yet.');
  const proc = TestProcess.start({
    label: 'kimi acp',
    command: kimiCliCommand(),
    args: ['acp'],
    cwd: home.workspace,
    env: kimiCliEnv(home),
    logDir: home.root,
    stdin: true,
    fetchStubs: offlineStubs(),
  });
  const driver = new AcpDriver(proc, home);
  try {
    await driver.open();
  } catch (error) {
    await driver.kill();
    throw error;
  }
  return driver;
}
