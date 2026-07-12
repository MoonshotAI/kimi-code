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

import { CLI_SHUTDOWN_TIMEOUT_MS, PROMPT_CLEANUP_TIMEOUT_MS } from '#/constant/app';

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

/**
 * Await `promise`, but stop waiting after `timeoutMs`.
 *
 * The timeout only bounds how long we WAIT — it does not change the outcome:
 *  - if `promise` settles first, its result is propagated (a rejection throws),
 *    so a cleanup step that actually fails in time still surfaces;
 *  - if the timeout wins, we resolve (give up waiting) and swallow the abandoned
 *    promise's eventual late rejection so it can't surface as an unhandled
 *    rejection.
 *
 * Used to bound shutdown so a wedged cleanup step can't keep a completed
 * headless run alive, without silently swallowing a cleanup that fails fast. The
 * timer stays ref'd so a cleanup step that suspends on an unref'd handle (e.g.
 * telemetry's retry backoff when the network is blocked) can't drain the event
 * loop and exit 0 before the rejection propagates — the timer keeps the loop
 * alive until it fires, then gives the rejection a chance to surface. A wedged
 * cleanup is still bounded by `timeoutMs`, so this can't hang the run forever.
 */
async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach the catch eagerly (synchronously) so `promise` is always consumed and
  // a late rejection can never become an unhandled rejection. Before the timeout
  // wins, the handler rethrows so a real cleanup failure still propagates.
  const guarded = promise.catch((error: unknown) => {
    if (timedOut) return;
    throw error;
  });
  const timedOutSignal = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([guarded, timedOutSignal]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await restorePromptSessionPermission();
      } finally {
        await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
        await harness.close();
      }
    })());
    // Bound cleanup so a wedged shutdown step (e.g. a SessionEnd hook, MCP
    // shutdown, or a connection blackholed by a restrictive firewall) cannot
    // keep a completed headless run alive forever. The cleanup keeps running in
    // the background if it overruns; the caller (`kimi -p`) force-exits shortly
    // after, so any straggling work is torn down with the process.
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
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
      sessionId: session.id,
    });
    setCrashPhase('runtime');

    const outputFormat = opts.outputFormat ?? 'text';
    // Headless goal mode: `kimi -p "/goal <objective>"`. The goal driver keeps
    // the turn-run alive across continuation turns, so the normal prompt-turn
    // waiter blocks until the goal is terminal; we then emit a summary and set a
    // distinct exit code.
    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runHeadlessGoal(session, goalCreate, goalModel, outputFormat, stdout, stderr);
    } else {
      await runPromptTurn(session, opts.prompt!, outputFormat, stdout, stderr);
    }
    writeResumeHint(session.id, outputFormat, stdout, stderr);

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
    drainAgentTasksOnStop: true,
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
  // A `kimi -p` run is not done just because the model ended a turn: an active
  // goal drives continuation turns on its own, and a scheduled cron task fires
  // later from an idle session — both trigger new turns after `end_turn`. While
  // either is pending, something must keep the event loop alive: the cron
  // scheduler's tick is deliberately unref'd, so without a ref'd handle the
  // process would drain and exit before the next turn is ever triggered. This
  // no-op interval is that handle; finish() always clears it.
  let keepAliveTimer: NodeJS.Timeout | undefined;
  const holdEventLoop = (): void => {
    keepAliveTimer ??= setInterval(() => {}, 60_000);
  };
  const releaseEventLoop = (): void => {
    if (keepAliveTimer === undefined) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  };

  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      releaseEventLoop();
      unsubscribe?.();
      outputWriter.finish();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };

    // Re-evaluates whether the run can settle now that the main agent is idle.
    // The run outlives a completed turn while a goal is still active (the goal
    // driver launches the next continuation turn itself) or while cron tasks
    // with a future fire remain (their fire steers a fresh turn when idle).
    // Called on turn.ended and on a terminal goal.updated — the latter covers
    // the driver blocking a goal on a hard budget, which emits no further
    // turn.ended. Only when neither is pending do we drain background tasks
    // and settle.
    const evaluateRunCompletion = async (): Promise<void> => {
      try {
        const { goal } = await session.getGoal();
        if (settled || activeTurnId !== undefined) return;
        if (goal?.status === 'active') {
          holdEventLoop();
          return;
        }
        const { tasks } = await session.getCronTasks();
        if (settled || activeTurnId !== undefined) return;
        // A task whose expression has no future fire can never trigger a
        // turn; don't hold the run open for it.
        if (tasks.some((task) => task.nextFireAt !== null)) {
          holdEventLoop();
          return;
        }
        await finishCompletedTurn();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    unsubscribe = session.onEvent((event) => {
      if (event.type === 'error') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        finish(new Error(`${event.code}: ${event.message}`));
        return;
      }
      if (event.type === 'turn.started') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        activeTurnId = event.turnId;
        activeAgentId = event.agentId;
        return;
      }
      if (
        event.type === 'goal.updated' &&
        event.agentId === PROMPT_MAIN_AGENT_ID &&
        activeTurnId === undefined &&
        event.snapshot !== null &&
        event.snapshot.status !== 'active'
      ) {
        void evaluateRunCompletion();
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
          outputWriter.writeRetrying(event);
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
            outputWriter.flushAssistant();
            activeTurnId = undefined;
            activeAgentId = undefined;
            void evaluateRunCompletion();
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
        case 'turn.step.completed':
        case 'warning':
          return;
      }
    });

    session.prompt(prompt).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    async function finishCompletedTurn(): Promise<void> {
      // Flush the buffered assistant message before the end-of-turn policy
      // runs: in stream-json mode the final message is only emitted by
      // finish(), so a long drain/steer wait would otherwise withhold the main
      // turn's result until the run exits.
      outputWriter.flushAssistant();
      try {
        const action = await session.handlePrintMainTurnCompleted();
        if (action === 'continue') {
          // Stay alive: a still-pending background task will, on completion,
          // steer the main agent into a new turn whose events we keep mapping.
          // Do not finish yet.
          holdEventLoop();
          return;
        }
      } catch (error) {
        log.warn('handlePrintMainTurnCompleted failed', { error });
      }
      finish();
    }
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
  writeRetrying(event: Extract<Event, { type: 'turn.step.retrying' }>): void;
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

  // Text `-p` keeps retries silent: only the failed attempt's partial assistant
  // text is discarded (handled by the caller). No human-readable retry line is
  // emitted, matching the prior behavior.
  writeRetrying(): void {}

  flushAssistant(): void {
    this.assistantWriter.finish();
  }

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

interface PromptJsonRetryMetaMessage {
  role: 'meta';
  type: 'turn.step.retrying';
  failed_attempt: number;
  next_attempt: number;
  max_attempts: number;
  delay_ms: number;
  error_name: string;
  error_message: string;
  status_code?: number;
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

  writeRetrying(event: Extract<Event, { type: 'turn.step.retrying' }>): void {
    // Emit a machine-readable meta line so stream-json consumers can observe
    // provider retries. The failed attempt's partial assistant text was already
    // discarded by the caller, so no half-formed assistant message leaks.
    const message: PromptJsonRetryMetaMessage = {
      role: 'meta',
      type: 'turn.step.retrying',
      failed_attempt: event.failedAttempt,
      next_attempt: event.nextAttempt,
      max_attempts: event.maxAttempts,
      delay_ms: event.delayMs,
      error_name: event.errorName,
      error_message: event.errorMessage,
      status_code: event.statusCode,
    };
    this.writeJsonLine(message);
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

  private writeJsonLine(
    message: PromptJsonAssistantMessage | PromptJsonToolMessage | PromptJsonRetryMetaMessage,
  ): void {
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
  if (event.reason === 'filtered') {
    return 'Provider safety policy blocked the response.';
  }
  return `Prompt turn ended with reason: ${event.reason}`;
}
