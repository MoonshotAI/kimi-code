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
  type SessionStatus,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import { resolve } from 'pathe';

import { CLI_SHUTDOWN_TIMEOUT_MS, PROMPT_CLEANUP_TIMEOUT_MS } from '#/constant/app';

import { isKimiV2Enabled } from './experimental-v2';
import { resolveOutputFormat } from './options';
import type { CLIOptions, PromptOutputFormat } from './options';
import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from './goal-prompt';
import type { PromptHarness, PromptSession } from './prompt-session';
import { PromptJsonWriter, PromptTranscriptWriter, writeResumeHint } from './prompt-render';
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
export async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
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

export interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

export interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

const PROMPT_UI_MODE = 'print';
const PROMPT_MAIN_AGENT_ID = 'main';

export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  if (isKimiV2Enabled()) {
    // The experimental agent-core-v2 engine runs on its own native DI service
    // runtime (see v2/run-v2-print.ts); it does not share the v1 PromptHarness
    // path below. Loaded lazily so the v2 module graph stays off the default
    // (v1) path.
    const { runV2Print } = await import('./v2/run-v2-print');
    await runV2Print(opts, version, io);
    return;
  }

  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = await createPromptHarness({
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

    // Headless goal mode: `kimi -p "/goal <objective>"`. The goal driver keeps
    // the turn-run alive across continuation turns, so the normal prompt-turn
    // waiter blocks until the goal is terminal; we then emit a summary and set a
    // distinct exit code.
    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runHeadlessGoal(session, goalCreate, goalModel, outputFormat, stdout, stderr);
    } else {
      await runPromptTurn(
        session as PrintTurnSession,
        opts.prompt!,
        outputFormat,
        stdout,
        stderr,
      );
    }
    writeResumeHint(session.id, outputFormat, stdout, stderr);

    withTelemetryContext({ sessionId: session.id }).track('exit', {
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await cleanupPromptRun();
  }
}

async function createPromptHarness(
  options: Parameters<typeof createKimiHarness>[0],
): Promise<PromptHarness> {
  // The v2 engine is dispatched earlier in `runPrompt` (see the
  // `isKimiV2Enabled()` branch) and never reaches here; this is the v1 path.
  return createKimiHarness(options);
}

async function runHeadlessGoal(
  session: PromptSession,
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
    await runPromptTurn(
      session as PrintTurnSession,
      goal.objective,
      outputFormat,
      stdout,
      stderr,
    );
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
  readonly session: PromptSession;
  readonly resumed: boolean;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel?: string;
  readonly goalModel?: string;
}

async function resolvePromptSession(
  harness: PromptHarness,
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
  session: PromptSession,
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

export function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

export function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

function installHeadlessHandlers(session: PromptSession): void {
  session.setApprovalHandler(() => ({ decision: 'approved' }));
  session.setQuestionHandler(() => null);
}

export function installPromptTerminationCleanup(
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

export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

type PrintTurnSession = PromptSession &
  Required<Pick<PromptSession, 'handlePrintMainTurnCompleted'>>;

function runPromptTurn(
  session: PrintTurnSession,
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

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  if (event.reason === 'blocked') {
    return 'Prompt hook blocked the request.';
  }
  return `Prompt turn ended with reason: ${event.reason}`;
}
