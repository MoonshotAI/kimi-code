import { randomUUID } from 'node:crypto';

import {
  AgentModelRef,
  AgentRunError,
  createUserMessage,
  describeUnknownError,
  MAIN_AGENT_ID,
  type AgentEmitted,
  type AgentHandle,
  type AgentRunResult,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';
import {
  CronRef,
  GoalRef,
  InteractionRef,
  PermissionRef,
  TaskRef,
  createNodeFsPort,
  interaction as interactionFeature,
  loadMcpServersDetailed,
  resolveAgentTaskConfig,
  resolveMcpJsonPaths,
  resolvePrintBackgroundMode,
  type GoalChange,
  type GoalSnapshot,
  type LoadMcpServersDetailedResult,
} from '@moonshot-ai/harness-core';
import {
  createKimiHarness,
  type KimiConfigFacade,
  type KimiHarness,
  type KimiSession,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import {
  CLI_SHUTDOWN_TIMEOUT_MS,
  CLI_USER_AGENT_PRODUCT,
  PROMPT_CLEANUP_TIMEOUT_MS,
} from '#/constant/app';
import { listSessionsByRecency } from '#/utils/sessions';

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from './goal-prompt';
import { resolveOutputFormat, type CLIOptions, type PromptOutputFormat } from './options';
import {
  PromptJsonWriter,
  PromptTranscriptWriter,
  writeExperimentalVersion,
  writeResumeHint,
  type PromptOutput,
  type PromptTurnWriter,
} from './prompt-render';
import {
  configuredModel,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
  type PromptRunIO,
} from './run-prompt';
import { createSessionWithStartupProfile } from './startup-profile';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { createKimiCodeUserAgent } from './version';

const PROMPT_UI_MODE = 'print';
const GOAL_WAIT_POLL_MS = 250;
const CRON_FIRE_GRACE_MS = 5_000;
const DRAIN_POLL_MS = 50;
const MODEL_BIND_POLL_MS = 25;
const MODEL_BIND_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 0x7fffffff;
export const PRINT_WAIT_CEILING_S_DEFAULT = Math.floor(MAX_TIMER_DELAY_MS / 1000);
const PRINT_MAX_TURNS_DEFAULT = 100_000;

export type PrintBackgroundMode = 'exit' | 'drain' | 'steer';

export interface RunPrintOptions {
  readonly bindAgent?: (agent: AgentHandle) => void;
}

export async function runPrint(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
  options: RunPrintOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();

  writeExperimentalVersion(version, outputFormat, stdout, stderr);

  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = await createKimiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: CLI_USER_AGENT_PRODUCT,
    uiMode: PROMPT_UI_MODE,
    workDir,
    version,
    userAgent: createKimiCodeUserAgent(),
    skillDirs: opts.skillsDirs,
    additionalDirs: opts.addDirs,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { outcome: 'success' });
        return;
      }
      track('oauth_refresh', { outcome: 'error', reason: outcome.reason });
    },
  });

  const defaultModel = harness.config.get<string>('defaultModel') ?? undefined;
  for (const diagnostic of harness.config.diagnostics()) {
    if (diagnostic.severity === 'warning') {
      stderr.write(`Warning: ${diagnostic.message}\n`);
    }
  }

  let cleanupPromise: Promise<void> | undefined;
  let removeTerminationCleanup: (() => void) | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await raceWithTimeout(harness.close(), CLI_SHUTDOWN_TIMEOUT_MS).catch(() => {});
      } finally {
        await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config: {
        defaultModel,
        telemetry: harness.config.get<boolean>('telemetry'),
      },
      version,
      uiMode: PROMPT_UI_MODE,
      model: opts.model,
    });
    setCrashPhase('runtime');

    await warnTrustGatedMcpServers(harness, workDir, stderr);

    const session = await resolvePrintSession(harness, opts, workDir, defaultModel, stderr);
    const main = session.main;
    harness.setTelemetryContext({ sessionId: session.id });
    setTelemetryContext({ sessionId: session.id });

    if (opts.model !== undefined) {
      const agentModel = main.resolve(AgentModelRef);
      if (agentModel === undefined) throw new Error('provider-catalog agent model is not available');
      await agentModel.setModel(opts.model);
    }
    const permission = main.resolve(PermissionRef);
    if (permission === undefined) throw new Error('permission feature is not installed');
    await permission.setMode('auto');
    const stopPermissionGuard = installPrintPermissionGuard(session);
    try {
      options.bindAgent?.(main);
      await waitForModelBinding(main, configuredModel(opts.model, defaultModel));

      const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
      if (goalCreate !== undefined) {
        await runPrintGoal(
          session,
          goalCreate,
          configuredModel(opts.model, defaultModel),
          outputFormat,
          stdout,
          stderr,
          harness.config,
        );
      } else {
        await runPrintTurn(session, opts.prompt!, outputFormat, stdout, stderr, harness.config);
      }
      writeResumeHint(session.id, outputFormat, stdout, stderr);

      withTelemetryContext({ sessionId: session.id }).track('exit', {
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      stopPermissionGuard();
    }
  } finally {
    await cleanup();
  }
}

async function resolvePrintSession(
  harness: KimiHarness,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
): Promise<KimiSession> {
  if (opts.session !== undefined) {
    return resumePrintSession(harness, opts.session);
  }
  if (opts.continue) {
    const latest = await latestSessionId(harness, workDir);
    if (latest !== undefined) {
      return resumePrintSession(harness, latest);
    }
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }
  requireConfiguredModel(opts.model, defaultModel);
  return createSessionWithStartupProfile(harness, {
    agentName: opts.agent,
    agentFile: opts.agentFiles[0],
    cwd: workDir,
  });
}

async function resumePrintSession(harness: KimiHarness, id: string): Promise<KimiSession> {
  const existing = await harness.app.space.get(id).catch(() => undefined);
  if (existing === undefined) {
    throw new Error(`Session "${id}" not found.`);
  }
  try {
    return await harness.resumeSession(id);
  } catch (error) {
    throw new Error(`Session "${id}" not found.`, { cause: error });
  }
}

async function latestSessionId(harness: KimiHarness, workDir: string): Promise<string | undefined> {
  const sessions = await listSessionsByRecency(harness, workDir);
  return sessions[0]?.id;
}

function installPrintPermissionGuard(session: KimiSession): () => void {
  const offs: Array<() => void> = [
    session.handle.on('agent.opened', (event) => {
      const agentId = event['agentId'];
      if (typeof agentId !== 'string' || agentId === MAIN_AGENT_ID) return;
      const target = session.handle.get(agentId);
      if (target === undefined) return;
      const permission = target.resolve(PermissionRef);
      if (permission !== undefined) void permission.setMode('auto').catch(() => {});
    }),
  ];
  const interactions = session.handle.resolve(InteractionRef);
  if (interactions !== undefined) {
    const answer = (id: string): void => {
      interactions.respond(id, { cancelled: true, reason: 'agent_closed' });
    };
    offs.push(
      session.handle.on(interactionFeature, 'interaction.requested', (event) => {
        answer(event.interaction.id);
      }),
    );
    for (const pending of interactions.findAll({ resolved: false })) {
      answer(pending.id);
    }
  }
  return () => {
    for (const off of offs) off();
  };
}

async function waitForModelBinding(
  main: AgentHandle,
  model: string | undefined,
): Promise<void> {
  if (main.model !== undefined) return;
  const deadline = Date.now() + MODEL_BIND_TIMEOUT_MS;
  while (main.model === undefined && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, MODEL_BIND_POLL_MS);
    });
  }
  if (main.model === undefined) {
    throw new Error(
      model === undefined
        ? 'No model bound to the agent. Configure default_model in config.toml, then retry.'
        : `Timed out waiting for model "${model}" to bind. Check the model alias and provider catalog, then retry.`,
    );
  }
}

async function runPrintGoal(
  session: KimiSession,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
  config: KimiConfigFacade,
): Promise<void> {
  requireConfiguredModel(model);
  const main = session.main;
  const goalFace = main.resolve(GoalRef);
  if (goalFace === undefined) throw new Error('goal feature is not installed');
  await goalFace.createGoal({ objective: goal.objective, replace: goal.replace });
  let completedSnapshot: GoalSnapshot | null = null;
  const off = session.handle.on('goal.updated', (event) => {
    const change = event['change'] as GoalChange | undefined;
    const snapshot = event['snapshot'] as GoalSnapshot | null;
    if (change?.kind === 'completion' && snapshot !== null) {
      completedSnapshot = snapshot;
    }
  });
  try {
    await runPrintTurn(session, goal.objective, outputFormat, stdout, stderr, config);
  } finally {
    off();
    const snapshot = completedSnapshot ?? goalFace.getGoal().goal;
    if (outputFormat === 'stream-json') {
      stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
    } else {
      stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
    }
    if (snapshot !== null && snapshot.status !== 'complete') {
      process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

async function runPrintTurn(
  session: KimiSession,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
  config: KimiConfigFacade,
): Promise<void> {
  const main = session.main;
  const writer: PromptTurnWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);

  const turnEndings = createPrintTurnEndings();
  const subscriptions = [
    main.on('llm.streaming.part', (event) => {
      const part = event.part;
      if (part.type === 'text') {
        writer.writeAssistantDelta(part.text);
        return;
      }
      if (part.type === 'think') {
        writer.writeThinkingDelta(part.think);
      }
    }),
    main.on('step.started', () => {
      writer.flushAssistant();
    }),
    main.on('llm.retrying', (event) => {
      if (event.reason !== 'backoff') return;
      writer.discardAssistant();
      writer.writeRetrying({
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.error.kind,
        errorMessage: event.error.message,
        statusCode: 'statusCode' in event.error ? event.error.statusCode : undefined,
      });
    }),
    main.on('turn.spawn_tools', (event) => {
      for (const toolCall of event.toolCalls) {
        writer.writeToolCall(toolCall.id, toolCall.name, toolCall.arguments ?? '');
      }
    }),
    main.on('tool.update', (event) => {
      const text = event.update.text;
      if (text.length > 0) {
        stderr.write(text.endsWith('\n') ? text : `${text}\n`);
      }
    }),
    main.on('tool.done', (event) => {
      writer.writeToolResult(event.toolCallId, toolOutcomeOutput(event.outcome));
    }),
    main.on('turn.done', (event) => {
      turnEndings.push({ turnId: event.turnId, outcome: event.outcome });
    }),
  ];
  try {
    const result = await runTurn(main, prompt);
    writer.flushAssistant();
    if (result.outcome.type !== 'done') {
      writer.finish();
      throw new Error(formatTurnFailure(result.outcome));
    }
    try {
      const taskConfig = resolveAgentTaskConfig(config);
      const ceilingS = taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
      await applyPrintBackgroundPolicy({
        mode: resolvePrintBackgroundMode(config),
        ceilingS,
        maxTurns: taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
        countPending: () => countPendingBackgroundTasks(session),
        drain: () => drainBackgroundTasks(session, ceilingS),
        turnEndings,
        skipTurnId: result.turnId,
        warn: (message) => stderr.write(`Warning: ${message}\n`),
        now: () => Date.now(),
        goalActive: () => main.resolve(GoalRef)?.getGoal().goal?.status === 'active',
        cronNextFireAt: () => cronNextFireAt(main),
      });
    } catch (error) {
      if (error instanceof PrintSteeredTurnFailedError) {
        writer.finish();
        throw error;
      }
      stderr.write(
        `Warning: print background policy failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    writer.finish();
  } catch (error) {
    writer.finish();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
  }
}

async function runTurn(main: AgentHandle, prompt: string): Promise<AgentRunResult> {
  try {
    return await main.run(createUserMessage(prompt), {
      meta: { origin: { kind: 'user' }, tracked: true, promptId: randomUUID() },
    });
  } catch (error) {
    if (error instanceof AgentRunError && error.code === 'blocked') {
      throw new Error('Prompt hook blocked the request.', { cause: error });
    }
    throw error;
  }
}

type ToolDoneOutcome = Extract<AgentEmitted, { type: 'tool.done' }>['outcome'];

function toolOutcomeOutput(outcome: ToolDoneOutcome): unknown {
  if (outcome.type === 'succeeded') {
    return outcome.result.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { type: 'text'; text: string }).text)
      .join('');
  }
  if (outcome.type === 'failed') {
    return describeUnknownError(outcome.error);
  }
  return outcome.reason instanceof Error
    ? outcome.reason.message
    : outcome.reason === undefined
      ? 'aborted'
      : describeUnknownError(outcome.reason);
}

export interface TrustGatedMcpServer {
  readonly name: string;
  readonly target: string;
}

type LoadedMcpServerConfig = LoadMcpServersDetailedResult['servers'][string];

async function warnTrustGatedMcpServers(
  harness: KimiHarness,
  workDir: string,
  stderr: PromptOutput,
): Promise<void> {
  try {
    if (harness.trust.isTrusted(workDir)) return;
    const fs = createNodeFsPort();
    const [paths, loaded] = await Promise.all([
      resolveMcpJsonPaths(fs, workDir, harness.homeDir),
      loadMcpServersDetailed({ fs, cwd: workDir, home: harness.homeDir, trusted: true }),
    ]);
    const projectPaths = new Set([paths.projectRoot, paths.project]);
    const gated = Object.entries(loaded.servers)
      .filter(([name]) => projectPaths.has(loaded.origins[name] ?? ''))
      .map(([name, config]) => ({ name, target: describeMcpTarget(config) }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    if (gated.length > 0) stderr.write(formatTrustGatedMcpWarning(gated));
  } catch {}
}

export function formatTrustGatedMcpWarning(servers: readonly TrustGatedMcpServer[]): string {
  const noun = servers.length === 1 ? 'server' : 'servers';
  const list = servers.map((server) => `${server.name} (${server.target})`).join(', ');
  return (
    `Warning: this folder is not trusted; skipped ${servers.length} project-level MCP ${noun}: ${list}.\n` +
    '  Run `kimi` here and choose "Trust this folder" to enable them.\n\n'
  );
}

function describeMcpTarget(config: LoadedMcpServerConfig): string {
  if (config.transport === 'stdio') {
    const args = config.args === undefined ? '' : ` ${config.args.join(' ')}`;
    return `stdio: ${config.command}${args}`;
  }
  return `${config.transport}: ${config.url}`;
}

function cronNextFireAt(main: AgentHandle): number | null {
  const cron = main.resolve(CronRef);
  if (cron === undefined) return null;
  if (cron.isDisabled()) return null;
  let next: number | null = null;
  for (const task of cron.list()) {
    const fireAt = cron.getNextFireForTask(task.id);
    if (fireAt === null) continue;
    if (next === null || fireAt < next) next = fireAt;
  }
  return next;
}

function countPendingBackgroundTasks(session: KimiSession): number {
  let count = 0;
  for (const agentId of session.handle.list()) {
    const agent = session.handle.get(agentId);
    if (agent === undefined) continue;
    const tasks = agent.resolve(TaskRef);
    if (tasks !== undefined) {
      for (const record of tasks.records.value.values()) {
        if (record.status === 'running') count++;
      }
    }
  }
  return count;
}

async function drainBackgroundTasks(session: KimiSession, ceilingS: number): Promise<void> {
  const deadline = Date.now() + ceilingS * 1000;
  while (Date.now() < deadline) {
    if (countPendingBackgroundTasks(session) === 0) return;
    await new Promise((resolve) => {
      setTimeout(resolve, DRAIN_POLL_MS);
    });
  }
}

function formatTurnFailure(outcome: TurnOutcome): string {
  if (outcome.type === 'failed') {
    const failure = outcome.failure;
    if (failure.reason === 'max_steps') return failure.message;
    const error = failure.error;
    if (typeof error === 'object' && error !== null && !(error instanceof Error)) {
      const record = error as { readonly kind?: unknown; readonly message?: unknown };
      if (typeof record.kind === 'string' && typeof record.message === 'string') {
        return `${record.kind}: ${record.message}`;
      }
    }
    if (error !== undefined) return describeUnknownError(error);
  }
  return `Prompt turn ended with reason: ${outcome.type}`;
}

export interface PrintTurnEnding {
  readonly turnId: number;
  readonly outcome: TurnOutcome;
}

export interface PrintTurnEndings {
  next(remainingMs: number, skipTurnId: number): Promise<PrintTurnEnding | null>;
}

export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards the single resolve; the rule cannot see it
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setTimeout(
                () => {
                  settle(null);
                },
                Math.min(ms, MAX_TIMER_DELAY_MS),
              )
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        if (ending === null) continue;
        if (ending.turnId !== skipTurnId) return ending;
      }
    },
  };
}

export class PrintSteeredTurnFailedError extends Error {}

export interface PrintBackgroundPolicyInput {
  readonly mode: PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  readonly goalActive?: () => boolean;
  readonly cronNextFireAt?: () => number | null;
}

export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    while (input.goalActive?.() === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(`print goal wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
    }

    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            'print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron',
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.outcome.type !== 'done') {
            throw new PrintSteeredTurnFailedError(formatTurnFailure(ended.outcome));
          }
          continue;
        }
      }
    }

    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(`print steer max turns reached (${input.maxTurns}), finishing`);
      return;
    }
    if (input.countPending() === 0) return;
    const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
    if (ended === null) return;
    if (ended.outcome.type !== 'done') {
      throw new PrintSteeredTurnFailedError(formatTurnFailure(ended.outcome));
    }
  }
}
