import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';
import chalk from 'chalk';
import {
  createKimiHarness,
  log,
  type Event,
  type GoalSnapshot,
  type HookResultEvent,
  type KimiHarness,
  type Session,
  type SessionStatus,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import { resolve } from 'pathe';

import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';
import { experimentalFeatureMap } from '#/utils/experimental-features';

import type { CLIOptions, PromptOutputFormat } from './options';
import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from './goal-prompt';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { createKimiCodeHostIdentity } from './version';

interface PromptOutput {
  readonly columns?: number | undefined;
  write(chunk: string): boolean;
}

interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

const PROMPT_UI_MODE = 'print';
const PROMPT_MAIN_AGENT_ID = 'main';
const PROMPT_BLOCK_BULLET = '• ';
const PROMPT_BLOCK_INDENT = '  ';

export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const workDir = process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = createKimiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    uiMode: PROMPT_UI_MODE,
    skillDirs: opts.skillsDirs,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { success: true });
        return;
      }
      track('oauth_refresh', { success: false, reason: outcome.reason });
    },
  });
  log.info('kimi-code starting', {
    version,
    uiMode: PROMPT_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });
  let restorePromptSessionPermission = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupPromptRun = async (): Promise<void> => {
    cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await restorePromptSessionPermission();
      } finally {
        await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
        await harness.close();
      }
    })();
    await cleanupPromise;
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanupPromptRun);

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    const { session, resumed, restorePermission, telemetryModel, goalModel } =
      await resolvePromptSession(
        harness,
        opts,
        workDir,
        config.defaultModel,
        stderr,
        (restorePermission) => {
          restorePromptSessionPermission = restorePermission;
        },
      );
    restorePromptSessionPermission = restorePermission;

    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version,
      uiMode: PROMPT_UI_MODE,
      model: telemetryModel,
    });
    setCrashPhase('runtime');

    withTelemetryContext({ sessionId: session.id }).track('started', {
      resumed,
      yolo: false,
      plan: false,
      afk: true,
    });

    const outputFormat = opts.outputFormat ?? 'text';
    // Headless goal mode: `kimi -p "/goal <objective>"`. The goal driver keeps
    // the turn-run alive across continuation turns, so the normal prompt-turn
    // waiter blocks until the goal is terminal; we then emit a summary and set a
    // distinct exit code.
    const flagMap = experimentalFeatureMap(await harness.getExperimentalFeatures());
    const goalCreate = parseHeadlessGoalCreate(opts.prompt!, flagMap['goal_command'] === true);
    if (goalCreate !== undefined) {
      await runHeadlessGoal(session, goalCreate, goalModel, outputFormat, stdout, stderr);
    } else {
      await runPromptTurn(session, opts.prompt!, outputFormat, stdout, stderr);
    }
    writeResumeHint(session.id, outputFormat, stdout, stderr);

    withTelemetryContext({ sessionId: session.id }).track('exit', {
      duration_s: (Date.now() - startedAt) / 1000,
    });
  } finally {
    await cleanupPromptRun();
  }
}

async function runHeadlessGoal(
  session: Session,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  requireConfiguredModel(model);
  await session.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
  let completedSnapshot: GoalSnapshot | null = null;
  const unsubscribeGoalEvents = session.onEvent((event) => {
    if (
      event.type === 'goal.updated' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });
  try {
    // The objective is sent as the normal prompt; goal continuation keeps the
    // turn alive until a terminal state is reached.
    await runPromptTurn(session, goal.objective, outputFormat, stdout, stderr);
  } finally {
    unsubscribeGoalEvents();
    const snapshot = completedSnapshot ?? (await session.getGoal()).goal;
    if (outputFormat === 'stream-json') {
      stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
    } else {
      stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
    }
    // Map the terminal goal status to a distinct, non-fatal exit code. A turn
    // that threw (error / cancellation) already propagates its own exit path.
    if (snapshot !== null && snapshot.status !== 'complete') {
      process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

interface ResolvedPromptSession {
  readonly session: Session;
  readonly resumed: boolean;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel?: string;
  readonly goalModel?: string;
}

async function resolvePromptSession(
  harness: KimiHarness,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<ResolvedPromptSession> {
  if (opts.session !== undefined) {
    const sessions = await harness.listSessions({ sessionId: opts.session, workDir });
    const target = sessions[0];
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    if (resolve(target.workDir) !== resolve(workDir)) {
      stderr.write(
        `${chalk.hex('#E8A838')(
          `Session "${opts.session}" was created under a different directory.\n` +
            `  cd "${target.workDir}" && kimi -r ${opts.session}`,
        )}\n\n`,
      );
      throw new Error(
        `Session "${opts.session}" was created under a different directory.`,
      );
    }
    const session = await harness.resumeSession({ id: opts.session });
    const status = await session.getStatus();
    const restorePermission = await forcePromptPermission(
      session,
      status.permission,
      setRestorePermission,
    );
    if (opts.model !== undefined) {
      await session.setModel(opts.model);
    }
    installHeadlessHandlers(session);
    return {
      session,
      resumed: true,
      restorePermission,
      telemetryModel: configuredModel(opts.model, status.model, defaultModel),
      goalModel: configuredModel(opts.model, status.model),
    };
  }

  if (opts.continue) {
    const sessions = await harness.listSessions({ workDir });
    const previous = sessions[0];
    if (previous !== undefined) {
      const session = await harness.resumeSession({ id: previous.id });
      const status = await session.getStatus();
      const restorePermission = await forcePromptPermission(
        session,
        status.permission,
        setRestorePermission,
      );
      if (opts.model !== undefined) {
        await session.setModel(opts.model);
      }
      installHeadlessHandlers(session);
      return {
        session,
        resumed: true,
        restorePermission,
        telemetryModel: configuredModel(opts.model, status.model, defaultModel),
        goalModel: configuredModel(opts.model, status.model),
      };
    }
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const session = await harness.createSession({ workDir, model, permission: 'auto' });
  installHeadlessHandlers(session);
  return {
    session,
    resumed: false,
    restorePermission: async () => {},
    telemetryModel: model,
    goalModel: model,
  };
}

async function forcePromptPermission(
  session: Session,
  previousPermission: SessionStatus['permission'],
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<() => Promise<void>> {
  let overridePermission: Promise<void> | undefined;
  const restorePermission = async () => {
    await overridePermission?.catch(() => {});
    if (previousPermission !== 'auto') {
      await session.setPermission(previousPermission);
    }
  };
  setRestorePermission(restorePermission);
  if (previousPermission !== 'auto') {
    overridePermission = session.setPermission('auto');
    await overridePermission;
  }
  return restorePermission;
}

function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

function installHeadlessHandlers(session: Session): void {
  session.setApprovalHandler(() => ({ decision: 'approved' }));
  session.setQuestionHandler(() => null);
}

function installPromptTerminationCleanup(
  promptProcess: PromptProcess,
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      promptProcess.exit(signalExitCode(signal));
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function runPromptTurn(
  session: Session,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  let activeTurnId: number | undefined;
  let activeAgentId: string | undefined;
  const outputWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      outputWriter.finish();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };

    unsubscribe = session.onEvent((event) => {
      if (event.type === 'error') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        finish(new Error(`${event.code}: ${event.message}`));
        return;
      }
      if (event.type === 'turn.started' && activeTurnId === undefined) {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        activeTurnId = event.turnId;
        activeAgentId = event.agentId;
        return;
      }
      if (
        activeTurnId === undefined ||
        activeAgentId === undefined ||
        !hasTurnId(event) ||
        event.turnId !== activeTurnId ||
        event.agentId !== activeAgentId
      ) {
        return;
      }
      switch (event.type) {
        case 'turn.step.started':
        case 'turn.step.interrupted':
          outputWriter.flushAssistant();
          return;
        case 'turn.step.retrying':
          outputWriter.discardAssistant();
          return;
        case 'assistant.delta':
          outputWriter.writeAssistantDelta(event.delta);
          return;
        case 'hook.result':
          outputWriter.writeHookResult(event);
          return;
        case 'thinking.delta':
          outputWriter.writeThinkingDelta(event.delta);
          return;
        case 'tool.call.started':
          outputWriter.writeToolCall(event.toolCallId, event.name, event.args);
          return;
        case 'tool.call.delta':
          outputWriter.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
          return;
        case 'tool.result':
          outputWriter.writeToolResult(event.toolCallId, event.output);
          return;
        case 'tool.progress':
          if (event.update.text !== undefined && event.update.text.length > 0) {
            stderr.write(
              event.update.text.endsWith('\n') ? event.update.text : `${event.update.text}\n`,
            );
          }
          return;
        case 'turn.ended':
          if (event.reason === 'completed') {
            finish();
            return;
          }
          finish(new Error(formatTurnEndedFailure(event)));
          return;
        case 'agent.status.updated':
        case 'background.task.started':
        case 'background.task.terminated':
        case 'compaction.blocked':
        case 'compaction.cancelled':
        case 'compaction.completed':
        case 'compaction.started':
        case 'cron.fired':
        case 'goal.updated':
        case 'mcp.server.status':
        case 'session.meta.updated':
        case 'skill.activated':
        case 'subagent.completed':
        case 'subagent.failed':
        case 'subagent.spawned':
        case 'subagent.started':
        case 'subagent.suspended':
        case 'tool.list.updated':
        case 'turn.started':
        case 'turn.step.completed':
        case 'warning':
          return;
      }
    });

    session.prompt(prompt).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

interface PromptTurnWriter {
  writeAssistantDelta(delta: string): void;
  writeHookResult(event: HookResultEvent): void;
  writeThinkingDelta(delta: string): void;
  writeToolCall(toolCallId: string, name: string, args: unknown): void;
  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void;
  writeToolResult(toolCallId: string, output: unknown): void;
  flushAssistant(): void;
  discardAssistant(): void;
  finish(): void;
}

class PromptTranscriptWriter implements PromptTurnWriter {
  private readonly assistantWriter: PromptBlockWriter;
  private readonly thinkingWriter: PromptBlockWriter;

  constructor(stdout: PromptOutput, stderr: PromptOutput) {
    this.assistantWriter = new PromptBlockWriter(stdout);
    this.thinkingWriter = new PromptBlockWriter(stderr);
  }

  writeAssistantDelta(delta: string): void {
    this.thinkingWriter.finish();
    this.assistantWriter.write(delta);
  }

  writeHookResult(event: HookResultEvent): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
    this.assistantWriter.write(formatHookResultPlain(event));
    this.assistantWriter.finish();
  }

  writeThinkingDelta(delta: string): void {
    this.thinkingWriter.write(delta);
  }

  writeToolCall(): void {}

  writeToolCallDelta(): void {}

  writeToolResult(): void {}

  flushAssistant(): void {}

  discardAssistant(): void {}

  finish(): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
  }
}

interface PromptJsonToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface PromptJsonAssistantMessage {
  role: 'assistant';
  content?: string;
  tool_calls?: PromptJsonToolCall[];
}

interface PromptJsonToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

interface PromptJsonResumeMetaMessage {
  role: 'meta';
  type: 'session.resume_hint';
  session_id: string;
  command: string;
  content: string;
}

function writeResumeHint(
  sessionId: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): void {
  const command = `kimi -r ${sessionId}`;
  const content = `To resume this session: ${command}`;
  if (outputFormat === 'stream-json') {
    const message: PromptJsonResumeMetaMessage = {
      role: 'meta',
      type: 'session.resume_hint',
      session_id: sessionId,
      command,
      content,
    };
    stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  stderr.write(`${content}\n`);
}

class PromptJsonWriter implements PromptTurnWriter {
  private assistantText = '';
  private readonly toolCalls: PromptJsonToolCall[] = [];

  constructor(private readonly stdout: PromptOutput) {}

  writeAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  writeHookResult(event: HookResultEvent): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'assistant',
      content: formatHookResultPlain(event),
    });
  }

  writeThinkingDelta(): void {}

  writeToolCall(toolCallId: string, name: string, args: unknown): void {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) {
      existing.function.name = name;
      existing.function.arguments = stringifyJsonValue(args);
      return;
    }
    this.toolCalls.push({
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: stringifyJsonValue(args),
      },
    });
  }

  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    const toolCall = this.findOrCreateToolCall(toolCallId, name ?? '');
    if (name !== undefined) {
      toolCall.function.name = name;
    }
    if (argumentsPart !== undefined) {
      toolCall.function.arguments += argumentsPart;
    }
  }

  writeToolResult(toolCallId: string, output: unknown): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'tool',
      tool_call_id: toolCallId,
      content: stringifyToolOutput(output),
    });
  }

  flushAssistant(): void {
    if (this.assistantText.length === 0 && this.toolCalls.length === 0) return;
    const message: PromptJsonAssistantMessage = {
      role: 'assistant',
      content: this.assistantText.length > 0 ? this.assistantText : undefined,
      tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
    };
    this.writeJsonLine(message);
    this.discardAssistant();
  }

  discardAssistant(): void {
    this.assistantText = '';
    this.toolCalls.length = 0;
  }

  finish(): void {
    this.flushAssistant();
  }

  private findOrCreateToolCall(toolCallId: string, name: string): PromptJsonToolCall {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) return existing;
    const toolCall: PromptJsonToolCall = {
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: '',
      },
    };
    this.toolCalls.push(toolCall);
    return toolCall;
  }

  private writeJsonLine(message: PromptJsonAssistantMessage | PromptJsonToolMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

class PromptBlockWriter {
  private started = false;
  private atLineStart = false;
  private lineWidth = 0;
  private readonly wrapWidth: number | undefined;

  constructor(private readonly output: PromptOutput) {
    this.wrapWidth =
      typeof output.columns === 'number' && output.columns > PROMPT_BLOCK_INDENT.length + 1
        ? output.columns
        : undefined;
  }

  write(chunk: string): void {
    if (chunk.length === 0) return;
    let rendered = this.start();
    for (const char of chunk) {
      if (this.atLineStart && char !== '\n') {
        rendered += PROMPT_BLOCK_INDENT;
        this.atLineStart = false;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      const charWidth = visibleCharWidth(char);
      if (
        this.wrapWidth !== undefined &&
        !this.atLineStart &&
        char !== '\n' &&
        this.lineWidth + charWidth > this.wrapWidth
      ) {
        rendered += `\n${PROMPT_BLOCK_INDENT}`;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      rendered += char;
      if (char === '\n') {
        this.atLineStart = true;
        this.lineWidth = 0;
      } else {
        this.lineWidth += charWidth;
      }
    }
    this.output.write(rendered);
  }

  finish(): void {
    if (!this.started) return;
    this.output.write(this.atLineStart ? '\n' : '\n\n');
    this.started = false;
    this.atLineStart = false;
    this.lineWidth = 0;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    this.atLineStart = false;
    this.lineWidth = PROMPT_BLOCK_BULLET.length;
    return PROMPT_BLOCK_BULLET;
  }
}

function visibleCharWidth(char: string): number {
  return char === '\t' ? 4 : 1;
}

function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? '(empty)' : content;
}

function stringifyJsonValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json ?? '';
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const json = JSON.stringify(output);
  return json ?? String(output);
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  return `Prompt turn ended with reason: ${event.reason}`;
}
