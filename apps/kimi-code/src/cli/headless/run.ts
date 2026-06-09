import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  acquireSessionRunLock as acquireSdkSessionRunLock,
  createKimiHarness,
  type Event,
} from '@moonshot-ai/kimi-code-sdk';

import type { HeadlessCommand, HeadlessRunOptions } from './commands';
import {
  readHeadlessControlRequest,
  waitForHeadlessControlApplied,
  writeHeadlessControlRequest,
} from './control';
import { formatHeadlessMetadataHeader } from './output';
import {
  preflightHeadlessOutputDir,
  resolveHeadlessOutputDir,
  writeHeadlessGoalStatusFile,
  writeHeadlessResponseFile,
} from './output-files';
import {
  preflightHeadlessStatusFile,
  readHeadlessRunStatus,
  type HeadlessApprovalStatus,
  type HeadlessGoalStatus,
  type HeadlessRunFiles,
  type HeadlessRunState,
  type HeadlessRunStatus,
  type HeadlessRunSummary,
  writeHeadlessRunStatus,
} from './status-file';
import { createKimiCodeHostIdentity } from '../version';
import { createHeadlessApprovalHandler, getUnusedPlanFlagWarning } from './approval';

interface HeadlessOutput {
  write(chunk: string): boolean;
}

interface HeadlessRunIO {
  readonly stdout?: HeadlessOutput;
  readonly createHarness?: (options: {
    readonly identity: ReturnType<typeof createKimiCodeHostIdentity>;
    readonly uiMode: string;
    readonly skillDirs: readonly string[];
  }) => HeadlessHarness;
  readonly acquireSessionRunLock?: (input: {
    readonly sessionDir: string;
    readonly runId: string;
    readonly pid: number;
    readonly command: string;
  }) => Promise<HeadlessSessionRunLock>;
  readonly processSignals?: HeadlessProcessSignals;
}

type HeadlessSignalName = 'SIGINT' | 'SIGTERM';

interface HeadlessProcessSignals {
  once(signal: HeadlessSignalName, listener: () => void | Promise<void>): void;
  off(signal: HeadlessSignalName, listener: () => void | Promise<void>): void;
  exit(code: number): never;
}

interface HeadlessHarness {
  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<{ readonly defaultModel?: string }>;
  createSession(input: {
    readonly workDir: string;
    readonly model: string;
    readonly permission: 'auto';
  }): Promise<HeadlessSession>;
  resumeSession(input: { readonly id: string }): Promise<HeadlessSession>;
  listSessions(input?: {
    readonly workDir?: string;
    readonly sessionId?: string;
  }): Promise<readonly HeadlessSessionSummary[]>;
  close(): Promise<void>;
}

interface HeadlessSessionSummary {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
}

interface HeadlessSession {
  readonly id: string;
  readonly workDir: string;
  readonly summary?: HeadlessSessionSummary;
  onEvent(listener: (event: Event) => void): () => void;
  prompt(input: string): Promise<void>;
  cancel(): Promise<void>;
  createGoal(input: { readonly objective: string; readonly replace: boolean }): Promise<unknown>;
  getGoal(): Promise<{ readonly goal: GoalSnapshotLike | null }>;
  pauseGoal(input?: { readonly reason?: string }): Promise<unknown>;
  cancelGoal(input?: { readonly reason?: string }): Promise<unknown>;
  setApprovalHandler(handler: unknown): void;
  setQuestionHandler(handler: unknown): void;
  getStatus(): Promise<{ readonly permission: 'yolo' | 'manual' | 'auto'; readonly model?: string }>;
  setPermission(mode: 'auto' | 'manual' | 'yolo'): Promise<void>;
  setModel(model: string): Promise<void>;
}

interface HeadlessSessionRunLock {
  readonly sessionDir: string;
  readonly runId: string;
  release(): Promise<void>;
}

interface RunContext {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly workDir: string;
  readonly model: string | null;
  readonly statusFile?: string;
  readonly outputDir?: string;
  readonly metadataOnly: boolean;
  readonly goalMode: boolean;
  readonly summary: MutableHeadlessRunSummary;
  status: HeadlessRunStatus;
  files: HeadlessRunFiles;
  assistantMarkdown: string;
  currentTurnMarkdown: string;
  turnResponses: Array<{ readonly turnId: number | null; readonly markdown: string }>;
  goalTerminal: boolean;
  planApprovalSeen: boolean;
  statusWriteQueue: Promise<void>;
  statusWriteError: Error | null;
}

interface GoalSnapshotLike {
  readonly goalId?: string;
  readonly status?: string;
  readonly terminalReason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
}

type MutableHeadlessRunSummary = {
  -readonly [Key in keyof HeadlessRunSummary]: HeadlessRunSummary[Key];
};

export async function runHeadless(
  command: HeadlessCommand,
  version: string,
  io: HeadlessRunIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;

  switch (command.kind) {
    case 'status':
      await runHeadlessStatus(command.options, stdout);
      return;
    case 'goal-control':
      await runHeadlessGoalControl(command.options, stdout);
      return;
    case 'run':
      await runHeadlessRun(command.options, version, io, stdout);
      return;
  }
}

async function runHeadlessRun(
  options: HeadlessRunOptions,
  version: string,
  io: HeadlessRunIO,
  stdout: HeadlessOutput,
): Promise<void> {
  const runId = `run_${randomUUID()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let workDir = path.resolve(options.cwd ?? process.cwd());
  const prompt = options.prompt ?? options.goal ?? options.replaceGoal;
  if (prompt === undefined) throw new Error('Specify a prompt or goal for headless run.');
  const goalMode = options.goal !== undefined || options.replaceGoal !== undefined;

  if (options.statusFile !== undefined) {
    await preflightHeadlessStatusFile(options.statusFile);
  }
  const outputDir =
    options.outputDir === undefined && !goalMode
      ? undefined
      : resolveHeadlessOutputDir({
          explicitOutputDir: options.outputDir,
          statusFile: options.statusFile,
          runId,
        });
  if (outputDir !== undefined) {
    await preflightHeadlessOutputDir(outputDir);
  }

  const createHarness = io.createHarness ?? ((input) => createKimiHarness(input));
  const acquireSessionRunLock = io.acquireSessionRunLock ?? acquireSdkSessionRunLock;
  const harness = createHarness({
    identity: createKimiCodeHostIdentity(version),
    uiMode: 'headless',
    skillDirs: options.skillsDirs,
  });
  let lock: HeadlessSessionRunLock | undefined;
  let session: HeadlessSession | undefined;
  let context: RunContext | undefined;
  let lockReleased = false;
  let harnessClosed = false;
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) return;
    lockReleased = true;
    await lock?.release();
  };
  const closeHarness = async (): Promise<void> => {
    if (harnessClosed) return;
    harnessClosed = true;
    await harness.close();
  };
  const removeSignalHandlers = installHeadlessSignalHandlers({
    signals: io.processSignals ?? defaultProcessSignals,
    getContext: () => context,
    getSession: () => session,
    releaseLock,
    closeHarness,
  });

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    const resolved = await resolveHeadlessSession(harness, options, workDir, config.defaultModel);
    workDir = resolved.workDir;
    lock = await acquireSessionRunLock({
      sessionDir: resolved.sessionDir,
      runId,
      pid: process.pid,
      command: 'headless run',
    });
    session = resolved.session;
    context = createRunContext({
      runId,
      startedAtMs,
      startedAt,
      workDir,
      model: resolved.model,
      statusFile: options.statusFile,
      outputDir,
      metadataOnly: options.metadataOnly,
      goalMode,
      sessionId: session.id,
    });
    installHeadlessRunHandlers(session, options, context);
    if (goalMode) {
      await session.createGoal({
        objective: prompt,
        replace: options.replaceGoal !== undefined,
      });
      context.status = {
        ...context.status,
        control: {
          path: path.join(context.outputDir!, 'control.json'),
          supportedActions: ['pause_goal', 'cancel_goal', 'interrupt'],
          lastRequest: null,
          lastApplied: null,
        },
      };
    }
    await writeRunStatus(context, 'starting');
    await runHeadlessPromptTurn(session, prompt, context);
    recordUnusedPlanFlagWarning(context, options);
    await writeCurrentRunStatus(context);
    await finalizeHeadlessRun(context, stdout);
  } finally {
    removeSignalHandlers();
    await releaseLock();
    await closeHarness();
  }
}

const defaultProcessSignals: HeadlessProcessSignals = {
  once: (signal, listener) => {
    process.once(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
  exit: (code) => process.exit(code),
};

function installHeadlessSignalHandlers(input: {
  readonly signals: HeadlessProcessSignals;
  readonly getContext: () => RunContext | undefined;
  readonly getSession: () => HeadlessSession | undefined;
  readonly releaseLock: () => Promise<void>;
  readonly closeHarness: () => Promise<void>;
}): () => void {
  const sigintListener = () => handleHeadlessSignal('SIGINT', input);
  const sigtermListener = () => handleHeadlessSignal('SIGTERM', input);
  input.signals.once('SIGINT', sigintListener);
  input.signals.once('SIGTERM', sigtermListener);
  return () => {
    input.signals.off('SIGINT', sigintListener);
    input.signals.off('SIGTERM', sigtermListener);
  };
}

async function handleHeadlessSignal(
  signal: HeadlessSignalName,
  input: {
    readonly signals: HeadlessProcessSignals;
    readonly getContext: () => RunContext | undefined;
    readonly getSession: () => HeadlessSession | undefined;
    readonly releaseLock: () => Promise<void>;
    readonly closeHarness: () => Promise<void>;
  },
): Promise<void> {
  const context = input.getContext();
  const session = input.getSession();
  await session?.cancel().catch(() => {});
  if (context !== undefined) {
    updateRunStatus(context, 'cancelled', `signal.${signal.toLowerCase()}`, {
      error: new Error(`${signal} received`),
    });
    await writeCurrentRunStatus(context).catch(() => {});
  }
  await input.releaseLock().catch(() => {});
  await input.closeHarness().catch(() => {});
  input.signals.exit(signal === 'SIGINT' ? 130 : 143);
}

function recordUnusedPlanFlagWarning(context: RunContext, options: HeadlessRunOptions): void {
  const warning = getUnusedPlanFlagWarning({
    approvePlan: options.approvePlan,
    rejectPlan: options.rejectPlan,
    planApprovalSeen: context.planApprovalSeen,
  });
  if (warning === null) return;
  context.status = {
    ...context.status,
    warnings: [...context.status.warnings, warning],
  };
}

async function resolveHeadlessSession(
  harness: HeadlessHarness,
  options: HeadlessRunOptions,
  initialWorkDir: string,
  defaultModel: string | undefined,
): Promise<{
  readonly session: HeadlessSession;
  readonly sessionDir: string;
  readonly workDir: string;
  readonly model: string;
}> {
  if (options.session !== undefined) {
    const sessions = await harness.listSessions({ sessionId: options.session });
    const target = sessions[0];
    if (target === undefined) throw new Error(`Session "${options.session}" not found.`);
    if (options.cwd !== undefined && target.workDir !== initialWorkDir) {
      throw new Error(`Session "${options.session}" was created under a different directory.`);
    }
    const session = await harness.resumeSession({ id: options.session });
    const status = await session.getStatus();
    if (options.model !== undefined) await session.setModel(options.model);
    return {
      session,
      sessionDir: target.sessionDir,
      workDir: options.cwd === undefined ? target.workDir : initialWorkDir,
      model: requireConfiguredModel(options.model, status.model, defaultModel),
    };
  }

  if (options.continue) {
    const sessions = await harness.listSessions({ workDir: initialWorkDir });
    const previous = sessions[0];
    if (previous !== undefined) {
      const session = await harness.resumeSession({ id: previous.id });
      const status = await session.getStatus();
      if (options.model !== undefined) await session.setModel(options.model);
      return {
        session,
        sessionDir: previous.sessionDir,
        workDir: initialWorkDir,
        model: requireConfiguredModel(options.model, status.model, defaultModel),
      };
    }
  }

  const model = requireConfiguredModel(options.model, defaultModel);
  const session = await harness.createSession({
    workDir: initialWorkDir,
    model,
    permission: 'auto',
  });
  const sessionDir = session.summary?.sessionDir;
  if (sessionDir === undefined) {
    throw new Error(`Session "${session.id}" did not report a session directory.`);
  }
  return { session, sessionDir, workDir: initialWorkDir, model };
}

function installHeadlessRunHandlers(
  session: HeadlessSession,
  options: HeadlessRunOptions,
  context: RunContext,
): void {
  session.setApprovalHandler(
    createHeadlessApprovalHandler({
      approvePlan: options.approvePlan,
      rejectPlan: options.rejectPlan,
      onPlanApprovalRequired: (approval) => {
        context.planApprovalSeen = true;
        context.status = { ...context.status, approval };
        updateRunStatus(context, 'approval_required', 'approval.required');
      },
    }),
  );
  session.setQuestionHandler(() => null);
}

function createRunContext(input: {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly workDir: string;
  readonly model: string;
  readonly statusFile?: string;
  readonly outputDir?: string;
  readonly metadataOnly: boolean;
  readonly goalMode: boolean;
  readonly sessionId: string;
}): RunContext {
  const summary = emptySummary();
  const files: HeadlessRunFiles = {
    outputDir: input.outputDir ?? null,
    responses: [],
    finalResponse: null,
    goalStatus: null,
  };
  return {
    runId: input.runId,
    startedAtMs: input.startedAtMs,
    startedAt: input.startedAt,
    pid: process.pid,
    workDir: input.workDir,
    model: input.model,
    statusFile: input.statusFile,
    outputDir: input.outputDir,
    metadataOnly: input.metadataOnly,
    goalMode: input.goalMode,
    summary,
    files,
    assistantMarkdown: '',
    currentTurnMarkdown: '',
    turnResponses: [],
    goalTerminal: false,
    planApprovalSeen: false,
    statusWriteQueue: Promise.resolve(),
    statusWriteError: null,
    status: {
      schemaVersion: 1,
      runId: input.runId,
      pid: process.pid,
      sessionId: input.sessionId,
      turnId: null,
      state: 'starting',
      workDir: input.workDir,
      model: input.model,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      elapsedMs: 0,
      lastEvent: null,
      activeTool: null,
      summary,
      approval: null,
      goal: null,
      warnings: [],
      files,
      control: null,
      error: null,
      resumeCommand: `kimi -r ${input.sessionId}`,
    },
  };
}

function emptySummary(): MutableHeadlessRunSummary {
  return {
    turnStepCount: 0,
    toolCallCount: 0,
    completedToolCallCount: 0,
    failedToolCallCount: 0,
    assistantCharCount: 0,
    thinkingCharCount: 0,
  };
}

async function runHeadlessPromptTurn(
  session: HeadlessSession,
  prompt: string,
  context: RunContext,
): Promise<void> {
  let activeTurnId: number | null = null;
  let settled = false;
  let unsubscribe: (() => void) | undefined;
  let controlTimer: NodeJS.Timeout | undefined;
  let pendingControl = Promise.resolve();
  const appliedControls = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (controlTimer !== undefined) clearInterval(controlTimer);
      unsubscribe?.();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };

    if (context.status.control !== null) {
      controlTimer = setInterval(() => {
        pendingControl = pendingControl
          .then(() => applyControlRequest(session, context, appliedControls, finish))
          .catch((error: unknown) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            updateRunStatus(context, 'failed', 'control.failed', { error: normalized });
            finish(normalized);
          });
      }, 25);
    }

    unsubscribe = session.onEvent((event) => {
      if (event.type === 'error' && event.agentId === 'main') {
        const error = new Error(`${event.code}: ${event.message}`);
        updateRunStatus(context, 'failed', event.type, { error });
        finish(error);
        return;
      }
      if (event.agentId !== 'main') return;
      if (event.type === 'goal.updated') {
        handleGoalUpdated(context, event.snapshot as GoalSnapshotLike | null | undefined);
        if (context.goalTerminal && activeTurnId === null) finish();
        return;
      }
      if (event.type === 'turn.started' && activeTurnId === null) {
        activeTurnId = event.turnId;
      }
      if (!hasTurnId(event) || (activeTurnId !== null && event.turnId !== activeTurnId)) return;
      handleRunEvent(context, event);
      if (event.type === 'turn.ended') {
        if (event.reason === 'completed') {
          activeTurnId = null;
          updateRunStatus(context, finalRunStateForContext(context), event.type);
          if (!context.goalMode || context.goalTerminal) finish();
          return;
        }
        if (event.reason === 'cancelled' && context.status.state === 'interrupted') {
          activeTurnId = null;
          updateRunStatus(context, 'interrupted', event.type);
          finish();
          return;
        }
        const error = new Error(formatTurnEndedFailure(event));
        updateRunStatus(context, 'failed', event.type, { error });
        finish(error);
      }
    });

    session.prompt(prompt).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      updateRunStatus(context, 'failed', 'prompt.failed', { error: normalized });
      finish(normalized);
    });
  });
  await pendingControl;
}

async function applyControlRequest(
  session: HeadlessSession,
  context: RunContext,
  appliedControls: Set<string>,
  finish: () => void,
): Promise<void> {
  const control = context.status.control;
  if (control === null) return;
  const request = await readHeadlessControlRequest(control.path);
  if (request === null || request.runId !== context.runId || appliedControls.has(request.commandId)) {
    return;
  }
  appliedControls.add(request.commandId);
  context.status = {
    ...context.status,
    control: { ...control, lastRequest: request },
  };

  try {
    switch (request.action) {
      case 'pause_goal':
        await session.pauseGoal({ reason: 'headless control request' });
        break;
      case 'cancel_goal':
        await session.cancelGoal({ reason: 'headless control request' });
        break;
      case 'interrupt':
        context.status = { ...context.status, state: 'interrupted' };
        await session.pauseGoal({ reason: 'headless control request' }).catch(() => {});
        await session.cancel();
        break;
    }
    const nextControl = context.status.control;
    context.status = {
      ...context.status,
      state: request.action === 'interrupt' ? 'interrupted' : context.status.state,
      control:
        nextControl === null
          ? null
          : {
              ...nextControl,
              lastApplied: {
                commandId: request.commandId,
                action: request.action,
                appliedAt: new Date().toISOString(),
                result: 'applied',
              },
            },
    };
    updateRunStatus(context, context.status.state, 'control.applied');
    await writeCurrentRunStatus(context);
    if (request.action === 'interrupt') finish();
  } catch (error) {
    const nextControl = context.status.control;
    context.status = {
      ...context.status,
      control:
        nextControl === null
          ? null
          : {
              ...nextControl,
              lastApplied: {
                commandId: request.commandId,
                action: request.action,
                appliedAt: new Date().toISOString(),
                result: 'failed',
                error: { message: error instanceof Error ? error.message : String(error) },
              },
            },
    };
    updateRunStatus(context, context.status.state, 'control.failed');
    await writeCurrentRunStatus(context);
  }
}

function handleGoalUpdated(context: RunContext, snapshot: GoalSnapshotLike | null | undefined): void {
  if (snapshot === null || snapshot === undefined) return;
  const goal = goalStatusFromSnapshot(snapshot);
  context.status = { ...context.status, goal };
  context.goalTerminal = isTerminalGoalStatus(goal.status);
  updateRunStatus(context, context.status.state, 'goal.updated');
}

function handleRunEvent(context: RunContext, event: Event & { readonly turnId: number }): void {
  switch (event.type) {
    case 'turn.started':
      context.currentTurnMarkdown = '';
      updateRunStatus(context, 'running', event.type, { turnId: event.turnId });
      return;
    case 'turn.step.started':
      context.summary.turnStepCount += 1;
      updateRunStatus(context, 'running', event.type);
      return;
    case 'assistant.delta':
      context.assistantMarkdown += event.delta;
      context.currentTurnMarkdown += event.delta;
      context.summary.assistantCharCount += event.delta.length;
      updateRunStatus(context, 'running', event.type, { write: false });
      return;
    case 'thinking.delta':
      context.summary.thinkingCharCount += event.delta.length;
      updateRunStatus(context, 'running', event.type, { write: false });
      return;
    case 'tool.call.started':
      context.summary.toolCallCount += 1;
      context.status = {
        ...context.status,
        activeTool: {
          toolCallId: event.toolCallId,
          name: event.name,
          description: event.description,
        },
      };
      updateRunStatus(context, 'running', event.type);
      return;
    case 'tool.result':
      if (event.isError === true) {
        context.summary.failedToolCallCount += 1;
      } else {
        context.summary.completedToolCallCount += 1;
      }
      if (context.status.activeTool?.toolCallId === event.toolCallId) {
        context.status = { ...context.status, activeTool: null };
      }
      updateRunStatus(context, 'running', event.type);
      return;
    case 'turn.ended':
      if (event.reason === 'completed') {
        context.turnResponses.push({
          turnId: event.turnId,
          markdown: context.currentTurnMarkdown,
        });
      }
      return;
    default:
      updateRunStatus(context, context.status.state, event.type);
  }
}

function updateRunStatus(
  context: RunContext,
  state: HeadlessRunState,
  lastEvent: string,
  options: { readonly turnId?: number; readonly error?: Error; readonly write?: boolean } = {},
): void {
  const updatedAt = new Date().toISOString();
  context.status = {
    ...context.status,
    turnId: options.turnId ?? context.status.turnId,
    state,
    updatedAt,
    elapsedMs: Date.now() - context.startedAtMs,
    lastEvent,
    summary: { ...context.summary },
    files: context.files,
    error: options.error === undefined ? context.status.error : { message: options.error.message },
  };
  if (options.write !== false) scheduleCurrentRunStatus(context);
}

async function writeRunStatus(context: RunContext, state: HeadlessRunState): Promise<void> {
  updateRunStatus(context, state, context.status.lastEvent ?? 'run.status');
  await writeCurrentRunStatus(context);
}

async function writeCurrentRunStatus(context: RunContext): Promise<void> {
  if (context.statusFile === undefined) return;
  scheduleCurrentRunStatus(context);
  await flushScheduledRunStatusWrites(context);
}

function scheduleCurrentRunStatus(context: RunContext): void {
  if (context.statusFile === undefined) return;
  const statusFile = context.statusFile;
  const status = context.status;
  context.statusWriteQueue = context.statusWriteQueue
    .then(() => writeHeadlessRunStatus(statusFile, status))
    .catch((error: unknown) => {
      context.statusWriteError = error instanceof Error ? error : new Error(String(error));
    });
}

async function flushScheduledRunStatusWrites(context: RunContext): Promise<void> {
  await context.statusWriteQueue;
  if (context.statusWriteError !== null) throw context.statusWriteError;
}

async function finalizeHeadlessRun(
  context: RunContext,
  stdout: HeadlessOutput,
): Promise<void> {
  if (context.outputDir !== undefined) {
    const responses = context.turnResponses.length > 0
      ? context.turnResponses
      : [{ turnId: context.status.turnId, markdown: context.assistantMarkdown }];
    const responseFiles = [];
    for (const [index, response] of responses.entries()) {
      responseFiles.push(
        await writeHeadlessResponseFile({
          outputDir: context.outputDir,
          turnIndex: index + 1,
          turnId: response.turnId,
          markdown: response.markdown,
          updatedAt: context.status.updatedAt,
        }),
      );
    }
    const goalStatus =
      context.goalMode && context.status.goal !== null
        ? await writeHeadlessGoalStatusFile({
            outputDir: context.outputDir,
            goal: context.status.goal,
            updatedAt: context.status.updatedAt,
          })
        : null;
    context.files = {
      ...context.files,
      responses: responseFiles,
      finalResponse: responseFiles.at(-1) ?? null,
      goalStatus,
    };
    context.status = { ...context.status, files: context.files };
    await writeCurrentRunStatus(context);
  }

  const responseFormat = context.outputDir !== undefined
    ? 'files'
    : context.metadataOnly
      ? 'omitted'
      : 'markdown';
  const metadata = {
    type: 'headless.result',
    schemaVersion: 1,
    runId: context.runId,
    sessionId: context.status.sessionId,
    turnId: context.status.turnId,
    state: context.status.state,
    responseFormat,
    responseOmitted: responseFormat !== 'markdown',
    resumeCommand: context.status.resumeCommand,
    summary: context.status.summary,
    approval: context.status.approval,
    goal: context.status.goal,
    warnings: context.status.warnings,
    files: context.files,
  } satisfies Parameters<typeof formatHeadlessMetadataHeader>[0];
  stdout.write(formatHeadlessMetadataHeader(metadata));
  if (responseFormat === 'markdown') stdout.write(context.assistantMarkdown);
}

function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = models.find((item) => item !== undefined && item.trim().length > 0);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

function goalStatusFromSnapshot(snapshot: GoalSnapshotLike): HeadlessGoalStatus {
  return {
    goalId: snapshot.goalId ?? null,
    status: snapshot.status ?? null,
    reason: snapshot.terminalReason ?? null,
    turnsUsed: snapshot.turnsUsed ?? null,
    tokensUsed: snapshot.tokensUsed ?? null,
    wallClockMs: snapshot.wallClockMs ?? null,
  };
}

function isTerminalGoalStatus(status: string | null): boolean {
  return status === 'complete' || status === 'blocked' || status === 'paused' || status === 'cancelled';
}

function finalRunStateForContext(context: RunContext): HeadlessRunState {
  if (!context.goalMode) return 'completed';
  switch (context.status.goal?.status) {
    case 'complete':
      return 'completed';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'failed';
    default:
      return 'running';
  }
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  return `Headless turn ended with reason: ${event.reason}`;
}

async function runHeadlessStatus(
  options: Extract<HeadlessCommand, { readonly kind: 'status' }>['options'],
  stdout: HeadlessOutput,
): Promise<void> {
  const status = await readHeadlessRunStatus(options.file);
  if (options.json) {
    stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  stdout.write(formatHeadlessStatus(status));
}

async function runHeadlessGoalControl(
  options: Extract<HeadlessCommand, { readonly kind: 'goal-control' }>['options'],
  stdout: HeadlessOutput,
): Promise<void> {
  const status = await readHeadlessRunStatus(options.file);
  const control = status.control;
  if (control === null) {
    throw new Error('Status file does not contain a control path.');
  }
  if (!control.supportedActions.includes(options.action)) {
    throw new Error(`Headless run does not support control action "${options.action}".`);
  }

  const commandId = `cmd_${randomUUID()}`;
  await writeHeadlessControlRequest(control.path, {
    schemaVersion: 1,
    runId: status.runId,
    commandId,
    action: options.action,
    requestedAt: new Date().toISOString(),
  });

  if (options.wait) {
    const applied = await waitForHeadlessControlApplied({
      statusFile: options.file,
      commandId,
      timeoutMs: 30_000,
    });
    if (applied !== null) {
      stdout.write(`control ${applied.result} - ${applied.action} - command ${commandId}\n`);
      return;
    }
  }

  const written = await readHeadlessControlRequest(control.path);
  stdout.write(`control pending - ${written?.action ?? options.action} - command ${commandId}\n`);
}

function formatHeadlessStatus(status: HeadlessRunStatus): string {
  const parts: string[] = [status.state];
  if (status.sessionId !== null) parts.push(`session ${status.sessionId}`);
  if (status.turnId !== null) parts.push(`turn ${status.turnId}`);
  if (status.summary.toolCallCount > 0) {
    parts.push(`tools ${status.summary.completedToolCallCount}/${status.summary.toolCallCount}`);
  }
  if (status.activeTool !== null) parts.push(`tool ${status.activeTool.name}`);
  if (status.approval !== null) {
    parts.push(
      `${approvalLabel(status.approval.decision)} - ${status.approval.kind} - ${status.approval.message}`,
    );
  }
  if (status.goal !== null) {
    parts.push(
      `goal ${status.goal.status ?? 'unknown'} - turns ${status.goal.turnsUsed ?? 0} - tokens ${status.goal.tokensUsed ?? 0}`,
    );
  }
  if (status.files.outputDir !== null) {
    const completedResponses = status.files.responses.filter(
      (response) => response.state === 'completed',
    ).length;
    parts.push(`files ${completedResponses} - output ${status.files.outputDir}`);
  }
  if (status.control?.lastRequest !== null && status.control?.lastRequest !== undefined) {
    const request = status.control.lastRequest;
    if (status.control.lastApplied?.commandId === request.commandId) {
      parts.push(
        `control ${status.control.lastApplied.result} - ${request.action} - command ${request.commandId}`,
      );
    } else {
      parts.push(`control pending - ${request.action} - command ${request.commandId}`);
    }
  }
  parts.push(`updated ${status.updatedAt}`);
  return `${parts.join(' - ')}\n`;
}

function approvalLabel(decision: HeadlessApprovalStatus['decision']): string {
  return decision === 'required' ? 'approval required' : `approval ${decision}`;
}
