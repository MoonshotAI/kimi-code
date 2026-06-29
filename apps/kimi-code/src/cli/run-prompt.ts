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
import { createInterface } from 'node:readline';

import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';

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
  /** Source of stdin lines for `--input-format`. Defaults to a reader over `process.stdin`. */
  readonly stdin?: AsyncIterable<string>;
  /** Injectable clock for the background-task drain loop (tests). */
  readonly clock?: PromptClock;
  readonly process?: PromptProcess;
}

interface PromptClock {
  now(): number;
  sleep(ms: number): Promise<void>;
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
/** Generic non-retryable failure. */
const CLI_EXIT_FAILURE = 1;
/** Transient provider failure (connection/timeout/rate-limit/5xx) — safe to retry. Mirrors EX_TEMPFAIL. */
const CLI_EXIT_RETRYABLE = 75;

/** Env override for keeping background tasks alive past exit (matches the session resolver). */
const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
/** Default ceiling (seconds) for waiting on background tasks at exit when none is configured. */
const DEFAULT_PRINT_WAIT_CEILING_S = 3600;
/** Poll interval (ms) while draining background tasks at exit. */
const BACKGROUND_DRAIN_POLL_MS = 500;

/**
 * A turn-level failure (provider/turn error). Carries the structured code and
 * retryable flag so the prompt runner can emit a machine-readable error and pick
 * an exit code. Setup errors (no model, session not found, …) are plain Errors
 * and are not caught by the turn handler.
 */
class PromptTurnError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PromptTurnError';
  }
}

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
        track('oauth_refresh', { outcome: 'success' });
        return;
      }
      track('oauth_refresh', { outcome: 'error', reason: outcome.reason });
    },
    sessionStartedProperties: { yolo: false, plan: false, afk: true },
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
    for (const warning of (await harness.getConfigDiagnostics()).warnings) {
      stderr.write(`Warning: ${warning}\n`);
    }
    const { session, restorePermission, telemetryModel, goalModel } =
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

    // `--quiet` is shorthand for `--output-format text --final-message-only`.
    const finalOnly = (opts.finalMessageOnly ?? false) || opts.quiet === true;
    const outputFormat: PromptOutputFormat =
      opts.quiet === true ? 'text' : (opts.outputFormat ?? 'text');
    const inputFormat = opts.inputFormat;
    try {
      if (inputFormat !== undefined) {
        // Prompts come from stdin instead of `--prompt`. `stream-json` reads one
        // JSON user message per line and runs a turn for each (multi-turn);
        // `text` reads all of stdin as a single prompt.
        const lines = io.stdin ?? defaultStdinLines(process.stdin);
        if (inputFormat === 'stream-json') {
          for await (const command of readUserCommands(lines, stderr)) {
            await runPromptTurn(session, command, outputFormat, finalOnly, stdout, stderr);
          }
        } else {
          const command = (await collectLines(lines)).trim();
          if (command.length > 0) {
            await runPromptTurn(session, command, outputFormat, finalOnly, stdout, stderr);
          }
        }
      } else {
        // Headless goal mode: `kimi -p "/goal <objective>"`. The goal driver
        // keeps the turn-run alive across continuation turns, so the normal
        // prompt-turn waiter blocks until the goal is terminal; we then emit a
        // summary and set a distinct exit code.
        const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
        if (goalCreate !== undefined) {
          await runHeadlessGoal(
            session,
            goalCreate,
            goalModel,
            outputFormat,
            finalOnly,
            stdout,
            stderr,
          );
        } else {
          await runPromptTurn(session, opts.prompt!, outputFormat, finalOnly, stdout, stderr);
        }
      }
    } catch (error) {
      // A turn-level failure is reported through the chosen output format (so a
      // stream-json consumer keeps receiving JSON) and mapped to an exit code;
      // setup errors (no model, session not found, …) are not PromptTurnErrors
      // and propagate to the top-level handler instead.
      if (!(error instanceof PromptTurnError)) throw error;
      emitPromptError(error, outputFormat, stdout, stderr);
      process.exitCode = error.retryable ? CLI_EXIT_RETRYABLE : CLI_EXIT_FAILURE;
    }
    // Give background tasks a chance to finish before the session is closed (and
    // any stragglers killed). Gated by the same `keepAliveOnExit` config the
    // session uses: when keep-alive is on, tasks are left running and we skip the
    // wait entirely.
    await drainBackgroundTasksOnExit(
      session,
      resolveKeepAliveOnExit(config, process.env),
      resolvePrintWaitCeilingMs(config),
      outputFormat,
      finalOnly,
      stdout,
      stderr,
      io.clock ?? defaultPromptClock,
    );
    // `--final-message-only` keeps stdout to just the answer(s), so the resume
    // hint is suppressed in that mode.
    if (!finalOnly) {
      writeResumeHint(session.id, outputFormat, stdout, stderr);
    }

    withTelemetryContext({ sessionId: session.id }).track('exit', {
      duration_ms: Date.now() - startedAt,
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
  finalOnly: boolean,
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
      event.agentId === 'main' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });
  try {
    // The objective is sent as the normal prompt; goal continuation keeps the
    // turn alive until a terminal state is reached.
    await runPromptTurn(session, goal.objective, outputFormat, finalOnly, stdout, stderr);
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
    const session = await harness.resumeSession({
      id: opts.session,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    });
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
      const session = await harness.resumeSession({
        id: previous.id,
        additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      });
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
  const session = await harness.createSession({
    workDir,
    model,
    permission: 'auto',
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
  });
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
  const onSighup = () => exitAfterCleanup('SIGHUP');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  promptProcess.once('SIGHUP', onSighup);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
    promptProcess.off('SIGHUP', onSighup);
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

function runPromptTurn(
  session: Session,
  prompt: string,
  outputFormat: PromptOutputFormat,
  finalOnly: boolean,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  let activeTurnId: number | undefined;
  let activeAgentId: string | undefined;
  const outputWriter = createPromptTurnWriter(outputFormat, finalOnly, stdout, stderr);
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
      // Session-level notifications (background tasks, cron) are not tied to the
      // main turn, so they are surfaced before the turn/agent filter below.
      const notification = toNotificationMessage(event);
      if (notification !== undefined) {
        outputWriter.writeNotification(notification);
        return;
      }
      // TUI-level activity events (subagent lifecycle, warnings, skill/mcp/
      // compaction/goal/agent-status updates) are likewise not turn-scoped; emit
      // them as their own JSON lines so a stream-json consumer sees what the TUI
      // would render. (`tool.progress` is turn-scoped and handled below.)
      const activity = toActivityMessage(event);
      if (activity !== undefined) {
        outputWriter.writeActivity(activity);
        return;
      }
      if (event.type === 'error') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        finish(new PromptTurnError(event.code, event.message, event.retryable === true));
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
          // stream-json: a JSON line on stdout (keeping the live tool output in
          // the JSON stream); text: the raw chunk on stderr as before.
          if (outputFormat === 'stream-json') {
            outputWriter.writeActivity(toolProgressMessage(event));
          } else if (event.update.text !== undefined && event.update.text.length > 0) {
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
          finish(turnEndedError(event));
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
      finish(toPromptTurnError(error));
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
  writeNotification(message: PromptJsonNotificationMessage): void;
  /** Emits a TUI-level activity event (tool progress, subagent, warning, …) as its own line. */
  writeActivity(message: Record<string, unknown>): void;
  flushAssistant(): void;
  discardAssistant(): void;
  finish(): void;
}

function createPromptTurnWriter(
  outputFormat: PromptOutputFormat,
  finalOnly: boolean,
  stdout: PromptOutput,
  stderr: PromptOutput,
): PromptTurnWriter {
  if (outputFormat === 'stream-json') {
    return finalOnly ? new PromptFinalJsonWriter(stdout) : new PromptJsonWriter(stdout);
  }
  return finalOnly
    ? new PromptFinalTextWriter(stdout)
    : new PromptTranscriptWriter(stdout, stderr);
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

  writeNotification(): void {}

  writeActivity(): void {}

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

interface PromptJsonThinkingMessage {
  role: 'assistant';
  type: 'thinking';
  content: string;
}

/**
 * Asynchronous, non-turn notifications (background tasks, cron) surfaced as
 * their own JSONL line. `event` carries the originating session event type; the
 * remaining fields are event-specific.
 */
interface PromptJsonNotificationMessage {
  type: 'notification';
  event: string;
  taskId?: string;
  kind?: string;
  status?: string;
  description?: string;
  prompt?: string;
}

/** A turn-level failure surfaced as its own JSONL line in `stream-json` mode. */
interface PromptJsonErrorMessage {
  type: 'error';
  code: string;
  message: string;
  retryable: boolean;
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
  private thinkingText = '';
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

  writeThinkingDelta(delta: string): void {
    this.thinkingText += delta;
  }

  writeNotification(message: PromptJsonNotificationMessage): void {
    // Flush any in-flight assistant/thinking content first so the notification
    // never splits a streaming assistant message.
    this.flushAssistant();
    this.writeJsonLine(message);
  }

  writeActivity(message: Record<string, unknown>): void {
    // Same ordering guarantee as notifications: declare the activity after the
    // assistant content it follows.
    this.flushAssistant();
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

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
    // Thinking precedes the assistant/tool output of the same step so a viewer
    // can render the reasoning before the answer it produced.
    this.flushThinking();
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
    this.thinkingText = '';
    this.toolCalls.length = 0;
  }

  finish(): void {
    this.flushAssistant();
  }

  private flushThinking(): void {
    if (this.thinkingText.length === 0) return;
    this.writeJsonLine({
      role: 'assistant',
      type: 'thinking',
      content: this.thinkingText,
    });
    this.thinkingText = '';
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

  private writeJsonLine(
    message:
      | PromptJsonAssistantMessage
      | PromptJsonToolMessage
      | PromptJsonThinkingMessage
      | PromptJsonNotificationMessage,
  ): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * `--final-message-only` + `stream-json`: emit exactly one assistant message per
 * turn — the final step's text. Thinking, tool calls/results and notifications
 * are dropped. Each step boundary discards the previous step's buffer so only
 * the last step survives to `finish()`.
 */
class PromptFinalJsonWriter implements PromptTurnWriter {
  private assistantText = '';

  constructor(private readonly stdout: PromptOutput) {}

  writeAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  writeHookResult(): void {}

  writeThinkingDelta(): void {}

  writeToolCall(): void {}

  writeToolCallDelta(): void {}

  writeToolResult(): void {}

  writeNotification(): void {}

  writeActivity(): void {}

  flushAssistant(): void {
    // A new step supersedes the previous one; keep only the latest step's text.
    this.assistantText = '';
  }

  discardAssistant(): void {
    this.assistantText = '';
  }

  finish(): void {
    // Only emit when there is a final message: a failed turn settles through
    // finish() before its error line, so an empty emit would read as a spurious
    // successful empty answer. Mirrors PromptFinalTextWriter.
    if (this.assistantText.length > 0) {
      this.stdout.write(`${JSON.stringify({ role: 'assistant', content: this.assistantText })}\n`);
    }
  }
}

/**
 * `--final-message-only` + `text`: emit only the final step's assistant text.
 */
class PromptFinalTextWriter implements PromptTurnWriter {
  private assistantText = '';

  constructor(private readonly stdout: PromptOutput) {}

  writeAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  writeHookResult(): void {}

  writeThinkingDelta(): void {}

  writeToolCall(): void {}

  writeToolCallDelta(): void {}

  writeToolResult(): void {}

  writeNotification(): void {}

  writeActivity(): void {}

  flushAssistant(): void {
    this.assistantText = '';
  }

  discardAssistant(): void {
    this.assistantText = '';
  }

  finish(): void {
    if (this.assistantText.length > 0) {
      this.stdout.write(`${this.assistantText}\n`);
    }
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

function turnEndedError(event: Extract<Event, { type: 'turn.ended' }>): PromptTurnError {
  if (event.error !== undefined) {
    return new PromptTurnError(
      event.error.code,
      event.error.message,
      event.error.retryable === true,
    );
  }
  if (event.reason === 'filtered') {
    return new PromptTurnError(
      'provider.filtered',
      'Provider safety policy blocked the response.',
      false,
    );
  }
  return new PromptTurnError(
    `turn.${event.reason}`,
    `Prompt turn ended with reason: ${event.reason}`,
    false,
  );
}

/** Normalizes an error thrown by `session.prompt()` into a {@link PromptTurnError}. */
function toPromptTurnError(error: unknown): PromptTurnError {
  if (error instanceof PromptTurnError) return error;
  if (error !== null && typeof error === 'object') {
    const payload = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof payload.code === 'string' && typeof payload.message === 'string') {
      return new PromptTurnError(payload.code, payload.message, payload.retryable === true);
    }
  }
  return new PromptTurnError('internal', error instanceof Error ? error.message : String(error), false);
}

/**
 * Reports a turn-level failure through the active output format: a structured
 * `{"type":"error",…}` JSONL line on stdout for `stream-json`, or a plain-text
 * line on stderr for `text` (keeping `stream-json` stdout entirely JSON).
 */
function emitPromptError(
  error: PromptTurnError,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): void {
  if (outputFormat === 'stream-json') {
    const message: PromptJsonErrorMessage = {
      type: 'error',
      code: error.code,
      message: error.detail,
      retryable: error.retryable,
    };
    stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  stderr.write(`Error: ${error.message}\n`);
}

const defaultPromptClock: PromptClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Waits for active background tasks to finish before the session is closed,
 * bounded by the print-wait ceiling. Skipped entirely when `keepAliveOnExit` is
 * set (tasks are intentionally left running). In `stream-json` mode each task's
 * terminal outcome is surfaced as a notification line while waiting.
 */
async function drainBackgroundTasksOnExit(
  session: Session,
  keepAliveOnExit: boolean,
  ceilingMs: number,
  outputFormat: PromptOutputFormat,
  finalOnly: boolean,
  stdout: PromptOutput,
  stderr: PromptOutput,
  clock: PromptClock,
): Promise<void> {
  if (keepAliveOnExit) return;
  let active = await session.listBackgroundTasks({ activeOnly: true });
  if (active.length === 0) return;
  // `--final-message-only` promises a single final assistant message per turn,
  // so the drain still waits for tasks but does not emit their notifications.
  const unsubscribe =
    outputFormat === 'stream-json' && !finalOnly
      ? session.onEvent((event) => {
          const notification = toNotificationMessage(event);
          if (notification?.event === 'background.task.terminated') {
            stdout.write(`${JSON.stringify(notification)}\n`);
          }
        })
      : undefined;
  try {
    const deadline = clock.now() + ceilingMs;
    while (active.length > 0) {
      if (clock.now() >= deadline) {
        stderr.write(
          `Timed out after ${Math.round(ceilingMs / 1000)}s waiting for ${active.length} background task(s); they will be stopped.\n`,
        );
        return;
      }
      await clock.sleep(BACKGROUND_DRAIN_POLL_MS);
      active = await session.listBackgroundTasks({ activeOnly: true });
    }
  } finally {
    unsubscribe?.();
  }
}

/**
 * Resolves whether background tasks are kept alive past exit, mirroring the
 * session resolver: env override, then config, defaulting to false (drain).
 */
function resolveKeepAliveOnExit(
  config: { readonly background?: unknown },
  env: NodeJS.ProcessEnv,
): boolean {
  const envValue = parsePromptBooleanEnv(env[BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV]);
  if (envValue !== undefined) return envValue;
  const background = config.background as { keepAliveOnExit?: unknown } | undefined;
  return typeof background?.keepAliveOnExit === 'boolean' ? background.keepAliveOnExit : false;
}

/** Resolves the background-drain ceiling in milliseconds from config. */
function resolvePrintWaitCeilingMs(config: { readonly background?: unknown }): number {
  const background = config.background as { printWaitCeilingS?: unknown } | undefined;
  const seconds =
    typeof background?.printWaitCeilingS === 'number' && background.printWaitCeilingS > 0
      ? background.printWaitCeilingS
      : DEFAULT_PRINT_WAIT_CEILING_S;
  return seconds * 1000;
}

function parsePromptBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }
  return undefined;
}

/**
 * Maps session-level notification events (background tasks, cron) to a JSONL
 * notification line, or `undefined` for events that are not notifications.
 */
function toNotificationMessage(event: Event): PromptJsonNotificationMessage | undefined {
  switch (event.type) {
    case 'background.task.started':
    case 'background.task.terminated':
      return {
        type: 'notification',
        event: event.type,
        taskId: event.info.taskId,
        kind: event.info.kind,
        status: event.info.status,
        description: event.info.description,
      };
    case 'cron.fired':
      return {
        type: 'notification',
        event: 'cron.fired',
        prompt: event.prompt,
      };
    default:
      return undefined;
  }
}

/** Builds the JSON line for a turn-scoped `tool.progress` event (stream-json). */
function toolProgressMessage(event: Extract<Event, { type: 'tool.progress' }>): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: 'tool_progress',
    tool_call_id: event.toolCallId,
    kind: event.update.kind,
  };
  if (event.update.text !== undefined) message['text'] = event.update.text;
  if (event.update.percent !== undefined) message['percent'] = event.update.percent;
  return message;
}

/**
 * Maps a TUI-level activity event (subagent lifecycle, warnings, skill / MCP /
 * compaction / goal / agent-status / tool-list updates) to a JSON line, or
 * `undefined` for events that are not activity events. `tool.progress` is
 * turn-scoped and handled separately.
 */
function toActivityMessage(event: Event): Record<string, unknown> | undefined {
  switch (event.type) {
    case 'subagent.spawned': {
      const message: Record<string, unknown> = {
        type: 'subagent',
        event: event.type,
        subagent_id: event.subagentId,
        name: event.subagentName,
        run_in_background: event.runInBackground,
      };
      if (event.description !== undefined) message['description'] = event.description;
      return message;
    }
    case 'subagent.started':
      return { type: 'subagent', event: event.type, subagent_id: event.subagentId };
    case 'subagent.suspended':
      return {
        type: 'subagent',
        event: event.type,
        subagent_id: event.subagentId,
        reason: event.reason,
      };
    case 'subagent.completed':
      return {
        type: 'subagent',
        event: event.type,
        subagent_id: event.subagentId,
        result_summary: event.resultSummary,
      };
    case 'subagent.failed':
      return {
        type: 'subagent',
        event: event.type,
        subagent_id: event.subagentId,
        error: event.error,
      };
    case 'warning': {
      const message: Record<string, unknown> = { type: 'warning', message: event.message };
      if (event.code !== undefined) message['code'] = event.code;
      return message;
    }
    case 'skill.activated': {
      const message: Record<string, unknown> = {
        type: 'skill_activated',
        skill_name: event.skillName,
        trigger: event.trigger,
      };
      if (event.skillArgs !== undefined) message['skill_args'] = event.skillArgs;
      return message;
    }
    case 'mcp.server.status': {
      const message: Record<string, unknown> = {
        type: 'mcp_server_status',
        name: event.server.name,
        status: event.server.status,
        transport: event.server.transport,
        tool_count: event.server.toolCount,
      };
      if (event.server.error !== undefined) message['error'] = event.server.error;
      return message;
    }
    case 'compaction.started':
      return { type: 'compaction', event: event.type, trigger: event.trigger };
    case 'compaction.blocked':
    case 'compaction.cancelled':
      return { type: 'compaction', event: event.type };
    case 'compaction.completed':
      return {
        type: 'compaction',
        event: event.type,
        tokens_before: event.result.tokensBefore,
        tokens_after: event.result.tokensAfter,
        compacted_count: event.result.compactedCount,
      };
    case 'goal.updated': {
      const message: Record<string, unknown> = { type: 'goal_update' };
      if (event.snapshot !== null) {
        message['goal_id'] = event.snapshot.goalId;
        message['status'] = event.snapshot.status;
      }
      if (event.change !== undefined) message['change'] = event.change.kind;
      return message;
    }
    case 'agent.status.updated': {
      const message: Record<string, unknown> = { type: 'agent_status' };
      if (event.model !== undefined) message['model'] = event.model;
      if (event.contextTokens !== undefined) message['context_tokens'] = event.contextTokens;
      if (event.contextUsage !== undefined) message['context_usage'] = event.contextUsage;
      return message;
    }
    case 'tool.list.updated':
      return { type: 'tool_list_updated', reason: event.reason, server_name: event.serverName };
    default:
      return undefined;
  }
}

/** Default `--input-format` line source: a reader over the given stdin stream. */
function defaultStdinLines(input: NodeJS.ReadableStream): AsyncIterable<string> {
  return createInterface({ input, crlfDelay: Infinity });
}

/** Joins all input lines into a single string (for `--input-format text`). */
async function collectLines(lines: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];
  for await (const line of lines) {
    collected.push(line);
  }
  return collected.join('\n');
}

/**
 * Yields a prompt command per `user` message read from stdin as JSONL. Blank
 * lines, malformed JSON and non-`user` messages are skipped with a stderr note,
 * matching the kimi-cli `stream-json` input contract.
 */
async function* readUserCommands(
  lines: AsyncIterable<string>,
  stderr: PromptOutput,
): AsyncGenerator<string> {
  for await (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stderr.write(`Ignoring invalid JSON input line: ${line}\n`);
      continue;
    }
    const command = extractUserCommand(parsed);
    if (command === undefined) {
      stderr.write(`Ignoring non-user input message: ${line}\n`);
      continue;
    }
    if (command.length === 0) continue;
    yield command;
  }
}

/** Extracts the prompt text from a parsed `user` message, or `undefined`. */
function extractUserCommand(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const message = parsed as { role?: unknown; content?: unknown };
  if (message.role !== 'user') return undefined;
  return extractMessageText(message.content);
}

/** Concatenates the text of a message's content (string or content-part array). */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      texts.push((part as { text: string }).text);
    }
  }
  return texts.join('\n').trim();
}
