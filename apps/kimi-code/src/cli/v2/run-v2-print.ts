import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  IAgentCronService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  IOAuthToolkit,
  ISessionManager,
  ISessionRunGate,
  ITelemetryService,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  applyPrintModeConfigDefaults,
  createCloudAppender,
  ensureMainAgent,
  reloadOnStale,
  ErrorCodes,
  isError2,
  resumeSessionById,
  resolveSessionResumeTarget,
  type SessionResumeTarget,
  parseAgentFileText,
  resolveAgentPath,
  resolveAgentTaskConfig,
  resolveKimiHome,
  resolvePrintBackgroundMode,
  setClampedTimeout,
  type Error2,
  type Event2,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type LoopRunResult,
  type PrintBackgroundMode,
  type ServicesAccessor,
} from '@moonshot-ai/agent-core-v2';
import {
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import { SDKRpcClientV2 } from '@moonshot-ai/kimi-code-sdk';
import {
  initializeTelemetry,
  setCrashPhase,
  setTelemetryContext,
  setTelemetryModel,
  shouldEnableTelemetry,
  shutdownTelemetry,
} from '@moonshot-ai/kimi-telemetry';
import type { GoalUpdated } from '@moonshot-ai/agent-core-v2/features/goal/goalOps';
import type { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStepRetrying,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { HookResult } from '@moonshot-ai/agent-core-v2/features/externalHooks/agent/agentExternalHooksService';
import type {
  ToolCallStarted,
  ToolUpdated,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';

import {
  CLI_SHUTDOWN_TIMEOUT_MS,
  CLI_USER_AGENT_PRODUCT,
  PROMPT_CLEANUP_TIMEOUT_MS,
} from '#/constant/app';
import { currentKimiProfile, currentKimiRegionResolution } from '#/utils/region';

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
import { createKimiCodeHostIdentity } from '../host-identity';

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
const GOAL_WAIT_POLL_MS = 250;
const PROMPT_QUIESCE_POLL_MS = 10;
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
  const client = new SDKRpcClientV2({
    homeDir,
    identity: createKimiCodeHostIdentity(version),
    nonInteractive: true,
    skillDirs: opts.skillsDirs,
    agentFiles: opts.agentFiles,
  });
  const services = client.engineAccessor;
  const auth = services.get(IOAuthToolkit);

  const configService = services.get(IConfigService);
  await configService.ready;
  await applyPrintModeConfigDefaults(configService);
  const defaultModel = configService.get<string>('defaultModel') ?? undefined;
  let configTelemetryEnabled = true;
  try {
    configTelemetryEnabled = configService.get('telemetry') !== false;
  } catch {
    configTelemetryEnabled = true;
  }
  const telemetryEnabled = shouldEnableTelemetry({ enabled: configTelemetryEnabled });
  for (const diagnostic of configService.diagnostics()) {
    stderr.write(`${diagnostic.severity === 'error' ? 'Error' : 'Warning'}: ${diagnostic.message}\n`);
  }

  let restorePermission = async (): Promise<void> => {};
  let quiesceAgents = async (): Promise<void> => {};
  let releaseQuiescence: (() => void) | undefined;
  let flushWires = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let telemetryService: ITelemetryService | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await restorePermission();
        await raceWithTimeout(quiesceAgents(), CLI_SHUTDOWN_TIMEOUT_MS).catch(() => {});
      } finally {
        try {
          await Promise.all([
            raceWithTimeout(flushWires(), CLI_SHUTDOWN_TIMEOUT_MS).catch(() => {}),
            telemetryService !== undefined
              ? raceWithTimeout(telemetryService.shutdown(), CLI_SHUTDOWN_TIMEOUT_MS)
              : Promise.resolve(),
            shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {}),
          ]);
          await client.close();
        } finally {
          releaseQuiescence?.();
        }
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    telemetryService = services.get(ITelemetryService);
    if (telemetryEnabled) {
      telemetryService.addAppender(
        createCloudAppender(services, {
          deviceId,
          appName: CLI_USER_AGENT_PRODUCT,
          uiMode: PROMPT_UI_MODE,
          model: opts.model ?? defaultModel,
          getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
        }),
      );
      const regionResolution = currentKimiRegionResolution();
      initializeTelemetry({
        homeDir,
        deviceId,
        appName: CLI_USER_AGENT_PRODUCT,
        version,
        uiMode: PROMPT_UI_MODE,
        model: opts.model ?? defaultModel,
        region: regionResolution.region,
        regionSource: regionResolution.source,
        resolveRegion: () => currentKimiRegionResolution(),
        endpoint: () => currentKimiProfile().telemetryEndpoint,
        getAccessToken: async () =>
          (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
        onUnexpectedError: (error) => console.error('[unexpected]', error),
      });
    }

    const target = opts.session !== undefined || opts.continue
      ? await resolveSessionResumeTarget(services, opts.session === undefined
        ? { workDir, environmentId: opts.environment, environmentCwd: opts.environmentCwd }
        : { sessionId: opts.session })
      : undefined;
    try {
      const trust = await client.getWorkspaceTrustInfo(target?.workDir ?? workDir, {
        projectId: target?.projectId,
        environmentId: target?.environmentId ?? opts.environment,
        environmentCwd: target?.environmentCwd ?? opts.environmentCwd,
      });
      if (trust.gatedMcpServers.length > 0) {
        stderr.write(formatTrustGatedMcpWarning(trust.gatedMcpServers.map((server) => ({
          name: server.name,
          target: server.transport === 'stdio'
            ? `stdio: ${[server.command, ...server.args ?? []].join(' ')}`
            : `${server.transport}: ${server.url}`,
        })), opts.session));
      }
    } catch {}

    let resolved = await resolveNativeSession(services, opts, workDir, defaultModel, stderr, target);
    const { previousPermissionMode } = resolved;
    if (previousPermissionMode !== undefined) {
      restorePermission = async () => {
        resolved.agent.accessor.get(IAgentPermissionModeService).setMode(previousPermissionMode);
      };
    }
    quiesceAgents = async () => {
      releaseQuiescence = await quiesceSessionAgents(resolved.session, resolved.agent);
    };
    flushWires = () => flushSessionWires(resolved.session, resolved.agent);

    telemetryService.setContext({ session_id: resolved.session.id, model: resolved.telemetryModel });
    setTelemetryContext({ sessionId: resolved.session.id });
    setTelemetryModel(resolved.telemetryModel);
    setCrashPhase('runtime');
    if (firstLaunch) {
      telemetryService.track2('first_launch');
    }

    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    const runTurnOnce = async (): Promise<void> => {
      if (goalCreate !== undefined) {
        await ensureNativeGoal(resolved.agent, goalCreate, resolved.goalModel);
        await runNativeGoalTurn(
          services,
          resolved.session,
          resolved.agent,
          goalCreate.objective,
          outputFormat,
          stdout,
          stderr,
        );
      } else {
        await runNativeTurn(services, resolved.session, resolved.agent, opts.prompt!, outputFormat, stdout, stderr);
      }
    };
    try {
      await reloadOnStale(
        services,
        resolved.session.id,
        async () => {
          resolved.session.accessor.get(ISessionRunGate).begin();
          await runTurnOnce();
        },
        {
          onReloaded: async (session) => {
            stderr.write(`Session "${session.id}" was updated by another client; reloaded it.\n`);
            const agentContext = await ensureMainAgent(session);
            const agent = session.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId)!;
            if (opts.model !== undefined) await agent.accessor.get(IAgentLoopService).setModel(opts.model);
            agent.accessor.get(IAgentPermissionModeService).setMode('auto');
            resolved = { ...resolved, session, agent };
          },
        },
      );
    } catch (error) {
      if (!isError2(error) || error.code !== ErrorCodes.SESSION_OCCUPIED) throw error;
      reportSessionOccupied(error, outputFormat, stdout, stderr);
      return;
    }
    writeResumeHint(resolved.session.id, outputFormat, stdout, stderr);

    telemetryService.withContext({ session_id: resolved.session.id }).track2('exit', {
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await cleanup();
  }
}

interface ResolvedNativeSession {
  readonly session: ISessionScopeHandle;
  readonly agent: IAgentScopeHandle;
  readonly previousPermissionMode?: PermissionMode;
  readonly telemetryModel: string | undefined;
  readonly goalModel: string | undefined;
}

async function resolveNativeSession(
  services: ServicesAccessor,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
  target: SessionResumeTarget | undefined,
): Promise<ResolvedNativeSession> {
  const sessions = services.get(ISessionManager);

  let agentProfileName = opts.agent;
  const agentFile = opts.agentFiles[0];
  if (agentProfileName === undefined && agentFile !== undefined) {
    const agentFilePath = resolveAgentPath(
      agentFile,
      workDir,
      services.get(IBootstrapService).osHomeDir,
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

  const applyModelOverride = async (
    profile: IAgentLoopService,
    model: string | undefined,
  ): Promise<void> => {
    if (model !== undefined) await profile.setModel(model);
  };

  const resumeById = async (id: string): Promise<ISessionScopeHandle> => {
    const session = await resumeSessionById(services, id);
    if (session === undefined) {
      throw new Error(`Session "${id}" not found.`);
    }
    return session;
  };

  const notePlanMode = async (agent: IAgentScopeHandle, sessionId: string): Promise<void> => {
    if ((await agent.accessor.get(IAgentPlanService).status()) === null) return;
    stderr.write(
      `Session "${sessionId}" is in Plan mode, and its plan cannot be approved in print mode; ` +
        `review it with \`kimi -r ${sessionId}\`.\n`,
    );
  };

  const forceAuto = (agent: IAgentScopeHandle): PermissionMode => {
    const permissionMode = agent.accessor.get(IAgentPermissionModeService);
    const previous = permissionMode.mode;
    permissionMode.setMode('auto');
    return previous;
  };

  if (target !== undefined) {
    const session = await resumeById(target.id);
    const agentContext = await ensureMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId)!;
    await notePlanMode(agent, target.id);
    const profile = agent.accessor.get(IAgentLoopService);
    await applyModelOverride(profile, opts.model);
    const currentModel = profile.getModel();
    const previousPermissionMode = forceAuto(agent);
    return {
      session,
      agent,
      previousPermissionMode,
      telemetryModel: configuredModel(opts.model, currentModel, defaultModel),
      goalModel: configuredModel(opts.model, currentModel),
    };
  }

  if (opts.continue) {
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const session = await sessions.create({
    workDir,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    mainAgentBinding: {
      profile: agentProfileName ?? 'agent',
      model,
    },
    environmentId: opts.environment,
    environmentCwd: opts.environmentCwd,
  });
  const agentContext = await ensureMainAgent(session);
  const agent = session.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId)!;
  const plan = agent.accessor.get(IAgentPlanService);
  if ((await plan.status()) !== null) {
    plan.cancel();
    stderr.write('default_plan_mode is not applied in print mode, because Plan mode waits for your review.\n');
  }
  agent.accessor.get(IAgentPermissionModeService).setMode('auto');
  return {
    session,
    agent,
    telemetryModel: model,
    goalModel: model,
  };
}

export interface TrustGatedMcpServer {
  readonly name: string;
  readonly target: string;
}

export function formatTrustGatedMcpWarning(servers: readonly TrustGatedMcpServer[], sessionId?: string): string {
  const command = sessionId === undefined ? '`kimi` here' : `\`kimi -r ${sessionId}\``;
  const noun = servers.length === 1 ? 'server' : 'servers';
  const list = servers.map((server) => `${server.name} (${server.target})`).join(', ');
  return (
    `Warning: this folder is not trusted; skipped ${servers.length} project-level MCP ${noun}: ${list}.\n` +
    `  Run ${command} and choose "Trust and continue", or set KIMI_CODE_TRUST_WORKSPACE=1, to enable them.\n\n`
  );
}

async function runNativeTurn(
  services: ServicesAccessor,
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

  const sessionModel = agent.accessor.get(IAgentLoopService).getModel();
  await agent.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);

  const turnEndings = createPrintTurnEndings();
  const toolStatuses = new Map<string, string>();
  const subscription = agent.accessor.get(IEventBus).subscribe((event: Event2<any>) => {
    dispatchNativeEvent(writer, event, stderr, toolStatuses);
    if (event.type === 'turn.ended') turnEndings.push(event as TurnEnded);
  });
  try {
    const loop = agent.accessor.get(IAgentLoopService);
    const promptId = randomUUID();
    await loop.submit({ input: [{ type: 'text', text: prompt }], promptId });
    const handle = loop.promptHandle(promptId)!;
    const turn = await handle.launched;
    if (turn === undefined) {
      writer.finish();
      const completion = await handle.completion;
      throw new Error(
        completion.state === 'blocked'
          ? 'Prompt hook blocked the request.'
          : 'Prompt turn could not be started',
      );
    }
    const result = await turn.result;

    writer.flushAssistant();
    if (result.type === 'completed') {
      const skipTurnId = turn.id;
      if (skipTurnId === undefined) {
        throw new Error('Prompt turn ended before it started');
      }
      const configService = services.get(IConfigService);
      const taskConfig = resolveAgentTaskConfig(configService);
      const goalService = agent.accessor.get(IAgentGoalService);
      const cronService = agent.accessor.get(IAgentCronService);
      try {
        await applyPrintBackgroundPolicy({
          mode: resolvePrintBackgroundMode(configService),
          ceilingS: taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT,
          maxTurns: taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
          countPending: () => countPendingBackgroundTasks(session),
          drain: () => drainBackgroundTasks(session, taskConfig?.printWaitCeilingS),
          turnEndings,
          skipTurnId,
          warn: (message) => stderr.write(`Warning: ${message}\n`),
          now: () => Date.now(),
          goalActive: () => goalService.getGoal().goal?.status === 'active',
          cronNextFireAt: () => cronService.getNextFireTime(),
          turnActive: () => loop.snapshot().state === 'running',
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

const PRINT_EXIT_SESSION_OCCUPIED = 4;

function reportSessionOccupied(
  error: Error2,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): void {
  const message = error.message;
  if (outputFormat === 'stream-json') {
    stdout.write(
      `${JSON.stringify({ type: 'error', code: error.code, message, details: error.details })}\n`,
    );
  } else {
    stderr.write(`${message}\n`);
  }
  process.exitCode = PRINT_EXIT_SESSION_OCCUPIED;
}

async function ensureNativeGoal(
  agent: IAgentScopeHandle,
  goal: HeadlessGoalCreate,
  model: string | undefined,
): Promise<void> {
  requireConfiguredModel(model);
  const goalService = agent.accessor.get(IAgentGoalService);
  const existing = goalService.getGoal().goal;
  if (existing?.status === 'active' && existing.objective === goal.objective) return;
  await goalService.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
}

async function runNativeGoalTurn(
  services: ServicesAccessor,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  objective: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const goalService = agent.accessor.get(IAgentGoalService);
  let completedSnapshot: { readonly status: string } | null = null;
  const subscription = agent.accessor.get(IEventBus).subscribe((event: Event2<any>) => {
    if (event.type === 'goal.updated') {
      const updated = event as unknown as GoalUpdated;
      if (updated.change?.kind === 'completion' && updated.snapshot !== null) {
        completedSnapshot = updated.snapshot;
      }
    }
  });
  let turnError: unknown;
  try {
    await runNativeTurn(services, session, agent, objective, outputFormat, stdout, stderr);
  } catch (error) {
    turnError = error;
    throw error;
  } finally {
    subscription.dispose();
    if (!isError2(turnError) || turnError.code !== ErrorCodes.SESSION_STALE) {
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
}

function dispatchNativeEvent(
  writer: PromptTurnWriter,
  event: Event2<any>,
  stderr: PromptOutput,
  toolStatuses: Map<string, string>,
): void {
  switch (event.type) {
    case 'turn.step.started':
    case 'turn.step.interrupted':
      writer.flushAssistant();
      return;
    case 'turn.step.retrying':
      writer.discardAssistant();
      writer.writeRetrying(event as unknown as TurnStepRetrying);
      return;
    case 'assistant.delta':
      writer.writeAssistantDelta((event as unknown as AssistantDelta).delta);
      return;
    case 'hook.result':
      writer.writeHookResult(event as unknown as HookResult);
      return;
    case 'thinking.delta':
      writer.writeThinkingDelta((event as unknown as ThinkingDelta).delta);
      return;
    case 'tool.call.started': {
      const started = event as unknown as ToolCallStarted;
      writer.writeToolCall(started.toolCallId, started.name, started.args);
      return;
    }
    case 'tool.call.delta': {
      const delta = event as unknown as ToolCallDelta;
      writer.writeToolCallDelta(delta.toolCallId, delta.name, delta.argumentsPart);
      return;
    }
    case 'tool.result': {
      const result = event as unknown as ToolResultEvent;
      toolStatuses.delete(result.toolCallId);
      writer.writeToolResult(result.toolCallId, result.output);
      return;
    }
    case 'tool.updated': {
      const updated = event as unknown as ToolUpdated;
      if (updated.output !== undefined) {
        const text = updated.output.text;
        if (text.length > 0) stderr.write(text.endsWith('\n') ? text : `${text}\n`);
        return;
      }
      const status = updated.fields['status'];
      if (
        typeof status === 'string' &&
        status.length > 0 &&
        toolStatuses.get(updated.toolCallId) !== status
      ) {
        toolStatuses.set(updated.toolCallId, status);
        stderr.write(status.endsWith('\n') ? status : `${status}\n`);
      }
      return;
    }
  }
}

export type PrintTurnEnding = TurnEnded;

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
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setClampedTimeout(() => {
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
  readonly turnActive?: () => boolean;
}

export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    if (input.turnActive?.() === true) {
      const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
      if (ended !== null && ended.reason !== 'completed') {
        throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
      }
      if (ended === null) {
        input.warn(`print turn wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
      continue;
    }

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
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
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
  const agentManager = session.accessor.get(IAgentLifecycleService);
  for (const agent of agentManager.list()) {
    const handle = agentManager.handleOf(agent.agentId);
    if (handle === undefined) continue;
    count += handle.accessor.get(IAgentTaskService).list(true).length;
  }
  return count;
}

function collectSessionAgentHandles(
  session: ISessionScopeHandle,
  mainAgent: IAgentScopeHandle,
): IAgentScopeHandle[] {
  const agentManager = session.accessor.get(IAgentLifecycleService);
  const handles = new Set<IAgentScopeHandle>([mainAgent]);
  for (const agent of agentManager.list()) {
    const handle = agentManager.handleOf(agent.agentId);
    if (handle !== undefined) handles.add(handle);
  }
  return [...handles];
}

async function quiesceSessionAgents(
  session: ISessionScopeHandle,
  mainAgent: IAgentScopeHandle,
): Promise<(() => void) | undefined> {
  const handles = collectSessionAgentHandles(session, mainAgent);
  const loops = handles.flatMap((handle) => {
    try {
      return [handle.accessor.get(IAgentLoopService)];
    } catch {
      return [];
    }
  });
  await Promise.allSettled(
    handles.flatMap((handle) => {
      try {
        const tasks = handle.accessor.get(IAgentTaskService);
        return tasks.list(true).map((task) => tasks.stop(task.taskId, 'Session closed'));
      } catch {
        return [];
      }
    }),
  );
  for (;;) {
    for (const loop of loops) {
      for (const queueId of loop.snapshot().queue.map((item) => item.attributes?.promptId)) {
        if (queueId !== undefined) loop.cancel({ promptId: queueId });
      }
      loop.cancel();
    }
    await Promise.allSettled(loops.map((loop) => loop.settled()));
    const guards: { dispose(): void }[] = [];
    let frozen = true;
    for (const loop of loops) {
      let guard: { dispose(): void } | undefined;
      try {
        guard = loop.tryAcquireQuiescence();
      } catch {
        continue;
      }
      if (guard === undefined) {
        frozen = false;
        break;
      }
      guards.push(guard);
    }
    const busy = loops.some((loop) => {
      try {
        const snapshot = loop.snapshot();
        return snapshot.state === 'running' || snapshot.queue.length > 0;
      } catch {
        return false;
      }
    });
    if (frozen && !busy) {
      return () => {
        for (const guard of guards) guard.dispose();
      };
    }
    for (const guard of guards) guard.dispose();
    await new Promise((resolve) => {
      setTimeout(resolve, PROMPT_QUIESCE_POLL_MS);
    });
  }
}

async function flushSessionWires(
  session: ISessionScopeHandle,
  mainAgent: IAgentScopeHandle,
): Promise<void> {
  await Promise.allSettled(
    collectSessionAgentHandles(session, mainAgent).map((handle) =>
      handle.accessor.get(IEventDispatcher).flush(),
    ),
  );
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
    let activeCount = 0;
    const agentManager = session.accessor.get(IAgentLifecycleService);
    for (const agent of agentManager.list()) {
      const handle = agentManager.handleOf(agent.agentId);
      if (handle === undefined) continue;
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        activeCount++;
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        const remaining = Math.max(1, deadline - Date.now());
        const waiter = taskService.wait(task.taskId, remaining);
        batch.push(waiter);
        allWaiters.push(waiter);
      }
    }
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
