/**
 * Native v2 `kimi -p` (print mode) runner.
 *
 * Unlike the v1 path (and the former `V2PromptHarness` / `V2Session` shim), this
 * runner talks to agent-core-v2's native DI services directly — no
 * `PromptHarness`, no SDK-shaped session, no v2→v1 event translation. It:
 *   - `bootstrap()`s the app scope,
 *   - creates / resumes a session and its main agent via native services,
 *   - subscribes to the main agent's per-agent `IEventBus` and renders the
 *     native `DomainEvent` stream (payloads are already v1-protocol-shaped),
 *   - drives a turn through `IAgentPromptService.enqueue()` and awaits
 *     `Turn.result` for authoritative completion,
 *   - applies the print-mode background policy (config-driven, v1-aligned:
 *     `exit` / `drain` / `steer`) before exiting.
 *
 * Selected by `runPrompt` when `KIMI_CODE_EXPERIMENTAL_FLAG` is set.
 */

import { readFile } from 'node:fs/promises';

import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IOAuthToolkit,
  ISessionCronService,
  ISessionIndex,
  ISessionLifecycleService,
  ITelemetryService,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  agentCatalogRuntimeOptionsSeed,
  applyPrintModeConfigDefaults,
  bootstrap,
  createCloudAppender,
  ensureMainAgent,
  hostRequestHeadersSeed,
  logSeed,
  parseAgentFileText,
  resolveAgentPath,
  resolveAgentTaskConfig,
  resolveKimiHome,
  resolveLoggingConfig,
  resolvePrintBackgroundMode,
  skillCatalogRuntimeOptionsSeed,
  type DomainEvent,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type LoopRunResult,
  type PrintBackgroundMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDefaultHeaders, createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { resolve } from 'pathe';

import {
  CLI_SHUTDOWN_TIMEOUT_MS,
  CLI_USER_AGENT_PRODUCT,
  PROMPT_CLEANUP_TIMEOUT_MS,
} from '#/constant/app';

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from '../goal-prompt';
import {
  type PromptRunIO,
  configuredModel,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
} from '../run-prompt';
import { createKimiCodeHostIdentity } from '../version';

import { resolveOutputFormat } from '../options';
import type { CLIOptions, PromptOutputFormat } from '../options';
import {
  type PromptOutput,
  PromptJsonWriter,
  type PromptTurnWriter,
  PromptTranscriptWriter,
  writeExperimentalVersion,
  writeResumeHint,
} from '../prompt-render';

const PROMPT_UI_MODE = 'print';
/** Re-check `goalActive` at least this often while waiting for goal turns. */
const GOAL_WAIT_POLL_MS = 250;
/**
 * Slack on top of a scheduled cron fire time while waiting for the steered
 * turn: covers the 1s tick poll interval plus fire → inject → turn-launch
 * latency.
 */
const CRON_FIRE_GRACE_MS = 5_000;

export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();

  writeExperimentalVersion(version, outputFormat, stdout, stderr);

  const homeDir = resolveKimiHome();
  let firstLaunch = false;
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const identity = createKimiCodeHostIdentity(version);
  const hostHeaders = createKimiDefaultHeaders({ homeDir, ...identity });

  const { app } = bootstrap({ homeDir, clientVersion: version }, [
    ...logSeed(logging),
    ...hostRequestHeadersSeed(hostHeaders),
    // `--skillsDir` (v1 print parity): explicit skill dirs replace default
    // user / project discovery for this process.
    ...skillCatalogRuntimeOptionsSeed(opts.skillsDirs),
    // `--agent-file`: explicit agent definition files, registered with the
    // highest-precedence source for this process. Passed through unresolved —
    // the engine expands `~` and resolves relative paths against the session
    // workDir (mirroring `--skills-dir`).
    ...agentCatalogRuntimeOptionsSeed(opts.agentFiles),
  ]);
  const auth = app.accessor.get(IOAuthToolkit);

  const configService = app.accessor.get(IConfigService);
  await configService.ready;
  // Print-mode config defaults (task timeouts / loop step cap / subagent
  // timeout → unbounded) before anything resolves a session; only keys the
  // user left unset are filled, in the memory layer.
  await applyPrintModeConfigDefaults(configService);
  const defaultModel = configService.get<string>('defaultModel') ?? undefined;
  let telemetryEnabled = true;
  try {
    telemetryEnabled = configService.get('telemetry') !== false;
  } catch {
    telemetryEnabled = true;
  }
  for (const diagnostic of configService.diagnostics()) {
    if (diagnostic.severity === 'warning') {
      stderr.write(`Warning: ${diagnostic.message}\n`);
    }
  }

  let restorePermission = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let telemetryService: ITelemetryService | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await restorePermission();
      } finally {
        if (telemetryService !== undefined) {
          await raceWithTimeout(telemetryService.shutdown(), CLI_SHUTDOWN_TIMEOUT_MS);
        }
        app.dispose();
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    // Install the appender BEFORE resolving the session: `session_started` and
    // `session_load_failed` fire inside create()/resume(), so an appender wired
    // up only after resolveNativeSession() would drop them to the null appender.
    // The model below is the best known up front; a resumed session's real
    // model is reconciled via setContext once resolved.
    telemetryService = app.accessor.get(ITelemetryService);
    if (telemetryEnabled) {
      telemetryService.setAppender(
        createCloudAppender(app.accessor, {
          deviceId,
          appName: CLI_USER_AGENT_PRODUCT,
          uiMode: PROMPT_UI_MODE,
          model: opts.model ?? defaultModel,
          getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
        }),
      );
    }

    const resolved = await resolveNativeSession(app, opts, workDir, defaultModel, stderr);
    restorePermission = resolved.restorePermission;

    telemetryService.setContext({ sessionId: resolved.session.id, model: resolved.telemetryModel });
    if (firstLaunch) {
      telemetryService.track2('first_launch');
    }

    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runNativeGoal(
        app,
        resolved.session,
        resolved.agent,
        goalCreate,
        resolved.goalModel,
        outputFormat,
        stdout,
        stderr,
      );
    } else {
      await runNativeTurn(
        app,
        resolved.session,
        resolved.agent,
        opts.prompt!,
        outputFormat,
        stdout,
        stderr,
      );
    }
    writeResumeHint(resolved.session.id, outputFormat, stdout, stderr);

    telemetryService.withContext({ sessionId: resolved.session.id }).track2('exit', {
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await cleanup();
  }
}

interface ResolvedNativeSession {
  readonly session: ISessionScopeHandle;
  readonly agent: IAgentScopeHandle;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel: string | undefined;
  readonly goalModel: string | undefined;
}

async function resolveNativeSession(
  app: Scope,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
): Promise<ResolvedNativeSession> {
  const lifecycle = app.accessor.get(ISessionLifecycleService);
  const index = app.accessor.get(ISessionIndex);

  // `--agent` selects a catalog profile by name; otherwise `--agent-file`
  // implicitly selects the profile that file defines. The file
  // is parsed here (fatal on error) so a bad file fails before any turn.
  let agentProfileName = opts.agent;
  const agentFile = opts.agentFiles[0];
  if (agentProfileName === undefined && agentFile !== undefined) {
    const agentFilePath = resolveAgentPath(
      agentFile,
      workDir,
      app.accessor.get(IBootstrapService).osHomeDir,
    );
    let agentFileText: string;
    try {
      agentFileText = await readFile(agentFilePath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      agentProfileName = parseAgentFileText({
        path: agentFilePath,
        source: 'explicit',
        text: agentFileText,
      }).name;
    } catch (error) {
      throw new Error(
        `Invalid agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  // `--agent` / `--agent-file` bind an explicit profile; without them the
  // historical setModel path (default profile on first bind) is kept. A
  // same-name re-select on a resumed session keeps the profile and only applies
  // an explicitly requested model; a different name is rejected by the
  // engine's first-bind guard inside `bind`.
  const applyProfileSelection = async (
    profile: IAgentProfileService,
    model: string | undefined,
  ): Promise<void> => {
    if (agentProfileName !== undefined) {
      if (profile.data().profileName === agentProfileName) {
        if (model !== undefined) await profile.setModel(model);
        return;
      }
      await profile.bind({
        profile: agentProfileName,
        model: requireConfiguredModel(model ?? profile.getModel(), defaultModel),
      });
    } else if (model !== undefined) {
      await profile.setModel(model);
    }
  };

  const resumeById = async (id: string): Promise<ISessionScopeHandle> => {
    const session = await lifecycle.resume(id);
    if (session === undefined) {
      throw new Error(`Session "${id}" not found.`);
    }
    return session;
  };

  const forceAuto = (
    agent: IAgentScopeHandle,
  ): { readonly restorePermission: () => Promise<void> } => {
    const permissionMode = agent.accessor.get(IAgentPermissionModeService);
    const previous = permissionMode.mode;
    permissionMode.setMode('auto');
    return {
      restorePermission: async () => {
        permissionMode.setMode(previous);
      },
    };
  };

  if (opts.session !== undefined) {
    const page = await index.list({});
    const target = page.items.find((summary) => summary.id === opts.session);
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    if (target.cwd !== undefined && resolve(target.cwd) !== resolve(workDir)) {
      stderr.write(
        `Session "${opts.session}" was created under a different directory.\n` +
          `  cd "${target.cwd}" && kimi -r ${opts.session}\n\n`,
      );
      throw new Error(`Session "${opts.session}" was created under a different directory.`);
    }
    const session = await resumeById(opts.session);
    const agent = await ensureMainAgent(session);
    const profile = agent.accessor.get(IAgentProfileService);
    await applyProfileSelection(profile, opts.model);
    const currentModel = profile.getModel();
    const { restorePermission } = forceAuto(agent);
    return {
      session,
      agent,
      restorePermission,
      telemetryModel: configuredModel(opts.model, currentModel, defaultModel),
      goalModel: configuredModel(opts.model, currentModel),
    };
  }

  if (opts.continue) {
    const page = await index.list({});
    const previous = page.items.find((summary) => summary.cwd === workDir);
    if (previous !== undefined) {
      const session = await resumeById(previous.id);
      const agent = await ensureMainAgent(session);
      const profile = agent.accessor.get(IAgentProfileService);
      await applyProfileSelection(profile, opts.model);
      const currentModel = profile.getModel();
      const { restorePermission } = forceAuto(agent);
      return {
        session,
        agent,
        restorePermission,
        telemetryModel: configuredModel(opts.model, currentModel, defaultModel),
        goalModel: configuredModel(opts.model, currentModel),
      };
    }
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const session = await lifecycle.create({
    workDir,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    mainAgentBinding: {
      profile: agentProfileName ?? 'agent',
      model,
    },
  });
  const agent = await ensureMainAgent(session);
  agent.accessor.get(IAgentPermissionModeService).setMode('auto');
  return {
    session,
    agent,
    restorePermission: async () => {},
    telemetryModel: model,
    goalModel: model,
  };
}

async function runNativeTurn(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const writer: PromptTurnWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);

  await agent.accessor.get(IAuthSummaryService).ensureReady();

  const turnEndings = createPrintTurnEndings();
  const subscription = agent.accessor.get(IEventBus).subscribe((event: DomainEvent) => {
    dispatchNativeEvent(writer, event, stderr);
    // Arm the turn-endings collector before `turn.result` settles so a
    // background-task completion that steers a new turn right after the main
    // turn ends cannot have its `turn.ended` slip past the policy loop.
    if (event.type === 'turn.ended') turnEndings.push(event);
  });
  try {
    const handle = await agent.accessor.get(IAgentPromptService).enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const turn = await handle.launched;
    if (turn === undefined) {
      // A prompt blocked by an onBeforeSubmitPrompt hook never launches a turn.
      writer.finish();
      const completion = await handle.completion;
      throw new Error(
        completion.state === 'blocked'
          ? 'Prompt hook blocked the request.'
          : 'Prompt turn could not be started',
      );
    }
    const result = await turn.result;

    // Turn settled, but `-p` is not done until the print-mode background
    // policy says so (config-driven: exit / drain / steer). Flush the buffered
    // assistant message first so a long drain/steer wait does not withhold the
    // final message.
    writer.flushAssistant();
    if (result.type === 'completed') {
      const configService = app.accessor.get(IConfigService);
      const taskConfig = resolveAgentTaskConfig(configService);
      const goalService = agent.accessor.get(IAgentGoalService);
      const cronService = session.accessor.get(ISessionCronService);
      try {
        await applyPrintBackgroundPolicy({
          mode: resolvePrintBackgroundMode(configService),
          ceilingS: taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT,
          maxTurns: taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
          countPending: () => countPendingBackgroundTasks(session),
          drain: () => drainBackgroundTasks(session, taskConfig?.printWaitCeilingS),
          turnEndings,
          skipTurnId: turn.id,
          warn: (message) => stderr.write(`Warning: ${message}\n`),
          now: () => Date.now(),
          goalActive: () => goalService.getGoal().goal?.status === 'active',
          cronNextFireAt: () => cronService.getNextFireTime(),
        });
      } catch (error) {
        // A steered turn that fails fails the run (v1 parity). Anything else
        // is best-effort: a wedged background task must not fail the (already
        // completed) main turn.
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
      return;
    }
    writer.finish();
    throw new Error(formatNativeTurnFailure(result));
  } catch (error) {
    writer.finish();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    subscription.dispose();
  }
}

async function runNativeGoal(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  requireConfiguredModel(model);
  const goalService = agent.accessor.get(IAgentGoalService);
  await goalService.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
  let completedSnapshot: { readonly status: string } | null = null;
  const subscription = agent.accessor.get(IEventBus).subscribe((event: DomainEvent) => {
    if (
      event.type === 'goal.updated' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });
  try {
    await runNativeTurn(app, session, agent, goal.objective, outputFormat, stdout, stderr);
  } finally {
    subscription.dispose();
    const snapshot = completedSnapshot ?? goalService.getGoal().goal;
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

function dispatchNativeEvent(
  writer: PromptTurnWriter,
  event: DomainEvent,
  stderr: PromptOutput,
): void {
  switch (event.type) {
    case 'turn.step.started':
    case 'turn.step.interrupted':
      writer.flushAssistant();
      return;
    case 'turn.step.retrying':
      writer.discardAssistant();
      writer.writeRetrying(event);
      return;
    case 'assistant.delta':
      writer.writeAssistantDelta(event.delta);
      return;
    case 'hook.result':
      writer.writeHookResult(event);
      return;
    case 'thinking.delta':
      writer.writeThinkingDelta(event.delta);
      return;
    case 'tool.call.started':
      writer.writeToolCall(event.toolCallId, event.name, event.args);
      return;
    case 'tool.call.delta':
      writer.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
      return;
    case 'tool.result':
      writer.writeToolResult(event.toolCallId, event.output);
      return;
    case 'tool.progress':
      if (event.update.text !== undefined && event.update.text.length > 0) {
        stderr.write(event.update.text.endsWith('\n') ? event.update.text : `${event.update.text}\n`);
      }
      return;
  }
}

export type PrintTurnEnding = Extract<DomainEvent, { type: 'turn.ended' }>;

/**
 * Source of `turn.ended` events for the print steer loop. `next` resolves with
 * the next ending (skipping `skipTurnId`, the main turn's own buffered
 * ending), or `null` when `remainingMs` elapses first.
 */
export interface PrintTurnEndings {
  next(remainingMs: number, skipTurnId: number): Promise<PrintTurnEnding | null>;
}

/**
 * Buffered `turn.ended` collector fed from the agent event bus. Events that
 * arrive while no one is waiting are queued, so endings that fire between the
 * main turn settling and the policy loop starting are not missed.
 */
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
            ? setTimeout(() => {
                settle(null);
              }, ms)
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
        if (ending === null) return null;
        if (ending.turnId !== skipTurnId) return ending;
        // The skipped turn's own ending: keep waiting within the same budget.
      }
    },
  };
}

/** A background-task completion steered a new main turn that did not complete. */
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
  /**
   * Reports whether an agent goal is still `active`. v2 drives goal
   * continuation as new turns (v1 keeps a single turn alive), so a `-p` goal
   * run must stay alive until the goal leaves `active`, independent of the
   * background policy.
   */
  readonly goalActive?: () => boolean;
  /**
   * Reports the next scheduled cron fire time (epoch ms), or `null` when no
   * cron task has a future fire. While it returns non-null the policy keeps
   * the process alive — the cron tick timer itself is unref'd — waiting for
   * the fire to steer a new turn, then re-evaluating (a fired one-shot task
   * disappears; a recurring one reports its advanced next fire). Cron
   * liveness is independent of the background mode: it applies under
   * `exit`/`drain` too (v1 parity). Omitted = no cron waiting.
   */
  readonly cronNextFireAt?: () => number | null;
}

/**
 * Apply the print-mode (`kimi -p`) background-resource policy after the main
 * turn completes. A single loop re-evaluates the Session's live resources in
 * order on every round and stays alive while any of them is pending:
 *  - goal    : while a goal is `active`, keep waiting for its continuation
 *              turns (bounded by `ceilingS` as a safety net), regardless of
 *              the background mode; the goal summary drives the exit code.
 *  - cron    : while `cronNextFireAt` reports a future fire, keep waiting —
 *              the cron tick timer is unref'd, so the process must hold the
 *              event loop itself (v1 parity, independent of the mode). The
 *              fire steers a new turn; a steered turn that does not complete
 *              fails the run. Each round re-reads the next fire time, so a
 *              fired one-shot task ends the wait while a recurring one keeps
 *              it. A fire time that stays unchanged and in the past across
 *              two consecutive rounds means the tick is wedged: warn once and
 *              stop cron waiting instead of spinning.
 *  - mode    : 'exit'  → return immediately;
 *              'drain' → suppress + drain background tasks, then return;
 *              'steer' → while background tasks are still pending, stay alive
 *              so task completions steer new main turns; return once
 *              quiescent, or when the wall-clock ceiling (`ceilingS`) or the
 *              turn cap (`maxTurns`) is reached. A steered turn that does not
 *              complete fails the run.
 * The steer ceiling deadline is set once on entry, so goal/cron waiting
 * consumes the same budget.
 */
export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  // Cron anti-spin guard: the last fire time seen already in the past. Two
  // consecutive rounds with the same past fire time mean the tick never ran.
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    // (a) goal: while a goal is `active`, keep waiting for its continuation
    // turns. Also wake on a short poll: a goal can leave `active` without any
    // further turn.ended (budget block at a turn boundary, or a pause after a
    // continuation-launch failure), which would otherwise hang the run until
    // the ceiling. A continuation turn that does not complete pauses/blocks
    // the goal, so the condition exits on the next check.
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

    // (b) cron: keep the process alive until the pending fire steered a turn
    // (one-shot tasks vanish after firing; recurring ones advance their next
    // fire), then re-evaluate from the top.
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
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
          }
          // Fire observed (or its grace elapsed without a turn): re-read the
          // next fire time from the top.
          continue;
        }
      }
    }

    // (c) background-task mode.
    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    // 'steer'
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
    if (ended.reason !== 'completed') {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  if (ending.error?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (ending.error !== undefined) return `${ending.error.code}: ${ending.error.message}`;
  if (ending.reason === 'blocked') {
    return 'Prompt hook blocked the request.';
  }
  return `Prompt turn ended with reason: ${ending.reason}`;
}

function countPendingBackgroundTasks(session: ISessionScopeHandle): number {
  let count = 0;
  for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
    count += handle.accessor.get(IAgentTaskService).list(true).length;
  }
  return count;
}

async function drainBackgroundTasks(
  session: ISessionScopeHandle,
  ceilingS: number | undefined,
): Promise<void> {
  const ceilingMs =
    typeof ceilingS === 'number' && Number.isFinite(ceilingS) && ceilingS > 0
      ? ceilingS * 1000
      : PRINT_WAIT_CEILING_S_DEFAULT * 1000;

  const deadline = Date.now() + ceilingMs;
  const seen = new Set<string>();
  const allWaiters: Promise<unknown>[] = [];
  while (Date.now() < deadline) {
    const batch: Promise<unknown>[] = [];
    const suppressions: Promise<void>[] = [];
    let activeCount = 0;
    for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        activeCount++;
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        suppressions.push(taskService.suppressTerminalNotification(task.taskId));
        const remaining = Math.max(1, deadline - Date.now());
        const waiter = taskService.wait(task.taskId, remaining);
        batch.push(waiter);
        allWaiters.push(waiter);
      }
    }
    if (suppressions.length > 0) await Promise.all(suppressions);
    if (activeCount === 0 || batch.length === 0) break;
    await Promise.all(batch);
  }
  if (allWaiters.length > 0) await Promise.all(allWaiters);
}

function formatNativeTurnFailure(result: LoopRunResult): string {
  if (result.type === 'failed') {
    const error = result.error as { readonly code?: string; readonly message?: string } | undefined;
    if (error?.code === 'provider.filtered') {
      return 'Provider safety policy blocked the response.';
    }
    if (error?.code !== undefined) {
      return `${error.code}: ${error.message ?? ''}`.trimEnd();
    }
    if (result.error instanceof Error) {
      return result.error.message;
    }
  }
  return `Prompt turn ended with reason: ${result.type}`;
}
