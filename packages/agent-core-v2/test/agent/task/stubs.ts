import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  IAgentTaskService,
} from '#/agent/task/task';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { WireRecord } from '#/wire/record';
import type { TestAgentContext } from '../../harness';
import { IAgentToolExecutorService, type AgentToolHook } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { BashInput } from '#/agent/tools/os/bash/bash';
import type { SubagentToolInput } from '#/agent/tools/agent/agent';
import {
  composeToolExecutorHooks,
  memoryOutputStore,
  ToolExecutor as HandlerToolExecutor,
  type LegacyToolAgentContext,
  type ToolExecutionHandler,
  type ToolOutputStore,
} from '#/tool/executor';
import { AgentTaskRequestService, AgentTaskService } from '#/agent/task/taskService';
import { createTaskCompletionEntry, IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { LegacyExecutableToolAdapter } from '#/tool/executor/legacy-adapter';
import type { ExecutableToolContext, ExecutableToolResult, RunnableToolExecution } from '#/tool/toolContract';

let bashTaskSequence = 0;
let agentTaskSequence = 0;
const TASK_TOOLS = ['TaskList', 'TaskOutput', 'TaskStop', 'WaitFor'];

function ensureActiveTools(ctx: TestAgentContext, names: readonly string[]): void {
  const active = ctx.get(IAgentLoopService).data().activeToolNames;
  if (active === undefined || names.every((name) => active.includes(name))) return;
  ctx.get(IAgentLoopService).update({ activeToolNames: [...new Set([...active, ...names])] });
}

export function startBashTask(ctx: TestAgentContext, args: BashInput) {
  ensureActiveTools(ctx, ['Bash', ...TASK_TOOLS]);
  const toolCallId = `bash-task-${String(++bashTaskSequence)}`;
  fixtureCalls(ctx).permitted.add(toolCallId);
  return ctx.get(IAgentToolExecutorService).executor.execute({
    type: 'function',
    id: toolCallId,
    name: 'Bash',
    arguments: JSON.stringify(args),
  }, { turnId: 0 });
}

export function startAgentTask(ctx: TestAgentContext, args: SubagentToolInput) {
  ensureActiveTools(ctx, ['Agent', ...TASK_TOOLS]);
  return ctx.get(IAgentToolExecutorService).executor.execute({
    type: 'function',
    id: `agent-task-${String(++agentTaskSequence)}`,
    name: 'Agent',
    arguments: JSON.stringify(args),
  }, { turnId: 0 });
}

let loopTaskSequence = 0;

interface FixtureCalls {
  readonly permitted: Set<string>;
  readonly created: Map<string, (handler: ToolExecutionHandler) => void>;
}

const fixtureCallsByContext = new WeakMap<TestAgentContext, FixtureCalls>();

function fixtureCalls(ctx: TestAgentContext): FixtureCalls {
  const existing = fixtureCallsByContext.get(ctx);
  if (existing !== undefined) return existing;
  const calls: FixtureCalls = { permitted: new Set(), created: new Map() };
  fixtureCallsByContext.set(ctx, calls);
  ctx.get(IAgentToolExecutorService).registerHook({
    starting: (context) => calls.permitted.has(context.call.id) ? { skipPermitting: true } : undefined,
    observe: (event) => {
      if (event.type === 'created') calls.created.get(event.call.id)?.(event.handler);
    },
  });
  return calls;
}

async function startRegisteredTaskInLoop(
  ctx: TestAgentContext,
  name: string,
  args: { readonly run_in_background?: boolean; readonly background?: boolean },
): Promise<{ readonly handler: ToolExecutionHandler }> {
  ensureActiveTools(ctx, [name, ...TASK_TOOLS]);
  const toolCallId = `loop-task-${String(++loopTaskSequence)}`;
  const calls = fixtureCalls(ctx);
  calls.permitted.add(toolCallId);
  const created = new Promise<{ readonly handler: ToolExecutionHandler }>((resolve) => {
    calls.created.set(toolCallId, (handler) => resolve({ handler }));
  });
  ctx.mockNextResponse({
    type: 'function',
    id: toolCallId,
    name,
    arguments: JSON.stringify(args),
  });
  if (args.run_in_background !== true && args.background !== true) {
    ctx.mockNextResponse({ type: 'text', text: `${name} started` });
  }
  await ctx.rpc.prompt({ input: [{ type: 'text', text: `start ${name}` }] });
  const live = await Promise.race([created, ctx.get(IAgentLoopService).settled().then(() => undefined)]);
  if (live === undefined) throw new Error(`${name} did not start`);
  if (args.run_in_background === true || args.background === true) await ctx.get(IAgentLoopService).settled();
  return live;
}

export function startBashTaskInLoop(ctx: TestAgentContext, args: BashInput) {
  return startRegisteredTaskInLoop(ctx, 'Bash', args);
}

export function startAgentTaskInLoop(ctx: TestAgentContext, args: SubagentToolInput) {
  return startRegisteredTaskInLoop(ctx, 'Agent', args);
}

export function startQuestionTaskInLoop(
  ctx: TestAgentContext,
  args: { readonly questions: readonly unknown[]; readonly background?: boolean },
) {
  return startRegisteredTaskInLoop(ctx, 'AskUserQuestion', args);
}

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    storage,
  );
}

export function taskHistoryRecords(
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
): WireRecord[] {
  return infos.flatMap((info) => {
    const started = {
      type: TaskStarted.type,
      agentId,
      info: { ...info, status: 'running', endedAt: null },
    } as unknown as WireRecord;
    if (info.status === 'running') return [started];
    return [
      started,
      { type: TaskTerminated.type, agentId, info } as unknown as WireRecord,
    ];
  });
}

export async function restoreTaskHistory(
  ctx: { restore(records: readonly WireRecord[]): Promise<void> },
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
  preceding: readonly WireRecord[] = [],
): Promise<void> {
  await ctx.restore([...preceding, ...taskHistoryRecords(infos, agentId)]);
}

export interface RecordingAppendWrite {
  readonly path: string;
  readonly data: string;
}

export function recordingAppendFs(writes: RecordingAppendWrite[]): IHostFileSystem {
  return {
    mkdir: async () => {},
    writeText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
    appendText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
  } as unknown as IHostFileSystem;
}

export interface TaskChannel {
  readonly service: IAgentTaskService;
  readonly toolExecutor: IAgentToolExecutorService;
  readonly history: ConstructorParameters<typeof AgentTaskRequestService>[1];
  readonly raw: HandlerToolExecutor<LegacyToolAgentContext>;
  readonly outputs: IAgentTaskOutputService;
  readonly handlers: Map<string, ToolExecutionHandler>;
  readonly tasks: Map<string, ToolExecutionHandler>;
  readonly persisted: Set<string>;
}

export const channelsByService = new WeakMap<IAgentTaskService, TaskChannel>();
export const channelsByTool = new WeakMap<object, TaskChannel>();

export function createTaskChannel(
  options: {
    readonly outputPersistenceAvailable?: boolean;
    readonly persistence?: AgentTaskPersistence;
  } = {},
): TaskChannel {
  const persistence = options.outputPersistenceAvailable === false
    ? undefined
    : options.persistence ?? createAgentTaskPersistence(`/tmp/kimi-bash-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const store: ToolOutputStore = persistence ?? memoryOutputStore();
  const handlers = new Map<string, ToolExecutionHandler>();
  const hooks: AgentToolHook[] = [];
  const raw = new HandlerToolExecutor<LegacyToolAgentContext>([], {
    outputStore: store,
    get hook() {
      return composeToolExecutorHooks(hooks);
    },
  });
  const reduced = new AgentTaskService('main');
  const history = {
    _serviceBrand: undefined,
    getTask: (taskId: string) => reduced.get(taskId),
    list: (activeOnly: boolean, limit?: number) => reduced.list(activeOnly, limit),
    values: () => reduced.values(),
    reconcile: async () => {},
  };
  const toolExecutor = {
    executor: raw,
    handlers: () => [...handlers.values()],
    handler: (taskId: string) => handlers.get(taskId),
    handlerForCall: (toolCallId: string) => [...handlers.values()].find((handler) => handler.snapshot().id === toolCallId),
    release: (taskId: string) => {
      handlers.delete(taskId);
    },
    registerHook: (hook: AgentToolHook) => {
      hooks.push(hook);
      return {
        dispose: () => {
          const index = hooks.indexOf(hook);
          if (index >= 0) hooks.splice(index, 1);
        },
      };
    },
    registerLegacyStarting: () => ({ dispose: () => {} }),
    recordDupType: () => {},
  } as unknown as IAgentToolExecutorService;
  const outputs: IAgentTaskOutputService = {
    _serviceBrand: undefined,
    open: (taskId) => store.open(taskId),
    appendTaskOutput: async (taskId, chunk) => {
      if (persistence !== undefined) {
        await persistence.appendTaskOutput(taskId, chunk);
        return;
      }
      const output = store.open(taskId);
      output.append(chunk);
      await output.flush();
    },
    readTaskOutputSnapshot: async (taskId, maxPreviewBytes) => {
      if (persistence !== undefined) return persistence.readTaskOutputSnapshot(taskId, maxPreviewBytes);
      const output = handlers.get(taskId)?.output(maxPreviewBytes);
      if (output === undefined) return undefined;
      return {
        outputPath: output.path ?? '',
        outputSizeBytes: output.totalBytes,
        previewBytes: Buffer.byteLength(output.preview),
        truncated: output.truncated,
        preview: output.preview,
      };
    },
    readTaskOutputTail: async (taskId, maxBytes) => {
      if (persistence !== undefined) return persistence.readTaskOutputTail(taskId, maxBytes);
      const output = handlers.get(taskId)?.output(maxBytes);
      if (output === undefined) return undefined;
      const data = Buffer.from(output.preview, 'utf-8');
      return { offset: output.totalBytes - data.byteLength, data };
    },
    createCompletion: async (info, toolCallId) => {
      const output = handlers.get(info.taskId)?.output(info.kind === 'question' ? 16_000 : 0);
      const persisted = output === undefined ? await outputs.readTaskOutputSnapshot(info.taskId, 0) : undefined;
      const snapshot = output === undefined
        ? {
            ...(persisted ?? {
              outputPath: '',
              outputSizeBytes: 0,
              previewBytes: 0,
              truncated: false,
              preview: '',
            }),
            fullOutputAvailable: persistence !== undefined && persisted !== undefined,
          }
        : {
            outputPath: output.path,
            outputSizeBytes: output.totalBytes,
            previewBytes: Buffer.byteLength(output.preview),
            truncated: output.truncated,
            fullOutputAvailable: output.path !== undefined,
            preview: output.preview,
          };
      return createTaskCompletionEntry(info, toolCallId, snapshot);
    },
  };
  const service = new AgentTaskRequestService(toolExecutor, history, outputs);
  const channel: TaskChannel = {
    service,
    toolExecutor,
    history,
    raw,
    outputs,
    handlers,
    tasks: handlers,
    get persisted() {
      return new Set([...handlers.values()].flatMap((handler) => handler.output().path === undefined ? [] : [handler.taskId]));
    },
  };
  channelsByService.set(service, channel);
  return channel;
}

export interface ControlledTaskOptions {
  readonly description?: string;
  readonly output?: string | readonly string[];
  readonly completion?: Promise<string | ExecutableToolResult>;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

let controlledTaskSequence = 0;

export interface ControlledTask {
  readonly handler: ToolExecutionHandler;
  readonly resolve: (value: string | ExecutableToolResult) => void;
  readonly reject: (error: unknown) => void;
  readonly write: (chunk: string) => void;
}

interface ControlledOutput {
  write(chunk: string): void;
}

const CONTROLLED_TASK_TOOL = 'ControlledTask';

function controlledTaskDefinition(
  options: ControlledTaskOptions,
  toolCallId: string,
  controller: AbortController,
  completion: Promise<string | ExecutableToolResult>,
  output: ControlledOutput,
) {
  return {
    name: CONTROLLED_TASK_TOOL,
    description: 'Controlled task',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: () => controlledTaskExecution(options, toolCallId, controller, completion, output),
  };
}

function controlledTaskExecution(
  options: ControlledTaskOptions,
  toolCallId: string,
  controller: AbortController,
  completion: Promise<string | ExecutableToolResult>,
  output: ControlledOutput,
  onStarted?: (taskId: string) => void,
): RunnableToolExecution {
  const description = options.description ?? 'controlled task';
  return {
    approvalRule: CONTROLLED_TASK_TOOL,
    stopping: ({ reason }: { readonly reason: unknown }) => {
      controller.abort(reason);
    },
    execute: async (ctx: ExecutableToolContext) => {
      output.write = (chunk) => ctx.write?.(chunk);
      ctx.set?.({
        task: {
          kind: 'question',
          description,
          questionCount: 1,
          toolCallId,
          timeoutMs: options.timeoutMs,
        },
      });
      onStarted?.(ctx.taskId ?? ctx.toolCallId);
      if (options.detached !== false) {
        const text = `task_id: ${ctx.taskId ?? ctx.toolCallId}`;
        ctx.onDetach?.(() => ({ content: [{ type: 'text', text }] }));
        ctx.detach?.(text);
      }
      for (const chunk of options.output === undefined
        ? []
        : typeof options.output === 'string'
          ? [options.output]
          : options.output) {
        ctx.write?.(chunk);
      }
      let timedOut = false;
      const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        controller.abort('Timed out');
      }, options.timeoutMs);
      timeout?.unref?.();
      const onAbort = (): void => controller.abort(ctx.signal.reason);
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      const onExternalAbort = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted === true) onExternalAbort();
      else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const result = await raceWithAbort(completion, controller.signal);
        const normalized = typeof result === 'string' ? { output: result } : result;
        const text = typeof normalized.output === 'string'
          ? normalized.output
          : JSON.stringify(normalized.output);
        if (text.length > 0) ctx.write?.(text);
        ctx.set?.({
          task: {
            kind: 'question',
            description,
            questionCount: 1,
            toolCallId,
            timeoutMs: options.timeoutMs,
            timedOut: timedOut || undefined,
            stopReason: normalized.isError === true ? text : undefined,
          },
        });
        return normalized;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.set?.({
          task: {
            kind: 'question',
            description,
            questionCount: 1,
            toolCallId,
            timeoutMs: options.timeoutMs,
            timedOut: timedOut || undefined,
            stopReason: message,
          },
        });
        return { output: message, isError: true };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        ctx.signal.removeEventListener('abort', onAbort);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

function controlledCompletion(options: ControlledTaskOptions): {
  readonly promise: Promise<string | ExecutableToolResult>;
  readonly resolve: (value: string | ExecutableToolResult) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: string | ExecutableToolResult) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = options.completion ?? new Promise<string | ExecutableToolResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function startControlledTask(
  channel: TaskChannel,
  options: ControlledTaskOptions = {},
): Promise<ControlledTask> {
  const completion = controlledCompletion(options);
  const controller = new AbortController();
  const toolCallId = `controlled-${String(++controlledTaskSequence)}`;
  const output: ControlledOutput = {
    write: () => {
      throw new Error('controlled task output is not initialized');
    },
  };
  const tool = new LegacyExecutableToolAdapter(controlledTaskDefinition(options, toolCallId, controller, completion.promise, output));
  channel.raw.addExecute(tool);
  const handler = channel.raw.execute({
    type: 'function',
    id: toolCallId,
    name: 'ControlledTask',
    arguments: '{}',
  }, { turnId: 0 });
  channel.handlers.set(handler.taskId, handler);
  for (let attempt = 0; attempt < 50 && handler.snapshot().fields['task'] === undefined; attempt++) {
    await Promise.resolve();
  }
  if (handler.snapshot().fields['task'] === undefined) throw new Error('controlled task fields did not initialize');
  return {
    handler,
    resolve: completion.resolve,
    reject: completion.reject,
    write: (chunk) => output.write(chunk),
  };
}

interface ControlledCall {
  readonly execution: RunnableToolExecution;
}

const controlledCalls = new WeakMap<TestAgentContext, Map<string, ControlledCall>>();

export function installControlledTask(ctx: TestAgentContext): void {
  if (controlledCalls.has(ctx)) return;
  if (ctx.loopStarted) throw new Error('installControlledTask must run before the agent loop starts');
  const calls = new Map<string, ControlledCall>();
  controlledCalls.set(ctx, calls);
  fixtureCalls(ctx);
  ctx.get(IAgentToolRegistryService).register({
    name: CONTROLLED_TASK_TOOL,
    description: 'Controlled task',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    resolveExecution: ({ key }: { readonly key: string }) =>
      calls.get(key)?.execution ?? { output: `unknown controlled task ${key}`, isError: true },
  });
  ensureActiveTools(ctx, [CONTROLLED_TASK_TOOL, ...TASK_TOOLS]);
}

export async function startControlledTaskInLoop(
  ctx: TestAgentContext,
  options: ControlledTaskOptions = {},
): Promise<ControlledTask> {
  installControlledTask(ctx);
  ensureActiveTools(ctx, [CONTROLLED_TASK_TOOL, ...TASK_TOOLS]);
  const completion = controlledCompletion(options);
  const controller = new AbortController();
  const toolCallId = `controlled-${String(++controlledTaskSequence)}`;
  const output: ControlledOutput = {
    write: () => {
      throw new Error('controlled task output is not initialized');
    },
  };
  let started: (live: { readonly handler: ToolExecutionHandler }) => void = () => {};
  const handlerStarted = new Promise<{ readonly handler: ToolExecutionHandler }>((resolve) => {
    started = resolve;
  });
  const execution = controlledTaskExecution(options, toolCallId, controller, completion.promise, output, (taskId) => {
    const handler = ctx.get(IAgentToolExecutorService).handler(taskId);
    if (handler !== undefined) started({ handler });
  });
  controlledCalls.get(ctx)!.set(toolCallId, { execution });
  fixtureCalls(ctx).permitted.add(toolCallId);
  ctx.mockNextResponse({
    type: 'function',
    id: toolCallId,
    name: CONTROLLED_TASK_TOOL,
    arguments: JSON.stringify({ key: toolCallId }),
  });
  ctx.mockNextResponse({ type: 'text', text: 'controlled task started' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start controlled task' }] });
  const live = await Promise.race([
    handlerStarted,
    ctx.get(IAgentLoopService).settled().then(() => undefined),
  ]);
  if (live === undefined) throw new Error('controlled task did not start');
  const { handler } = live;
  if (options.detached !== false) await ctx.get(IAgentLoopService).settled();
  return {
    handler,
    resolve: completion.resolve,
    reject: completion.reject,
    write: (chunk) => output.write(chunk),
  };
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const listener = (): void => rejectAbort(signal.reason);
  signal.addEventListener('abort', listener, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
