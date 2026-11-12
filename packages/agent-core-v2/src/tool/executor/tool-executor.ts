import { randomBytes } from 'node:crypto';

import type { ContentPart } from '#human/llm/message';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { abortedToolOutput, isUserCancellation } from '#/_base/utils/abort';

import { memoryOutputStore } from './output-store';
import { ToolTimeoutError } from './types';
import type {
  AfterExecuteHookContext,
  ExecutableTool,
  ToolAbortType,
  ToolAcknowledgement,
  ToolCall,
  ToolDecision,
  ToolDecisionContext,
  ToolDetachAck,
  ToolError,
  ToolExecuteContext,
  ToolExecutionEvent,
  ToolExecutionHandler,
  ToolExecutionResponse,
  ToolExecutionSnapshot,
  ToolExecutorPolicy,
  ToolHandlerEvent,
  ToolOutcome,
  ToolOutput,
  ToolOutputSnapshot,
  ToolOutputStore,
  ToolPhase,
  ToolResult,
  ToolReturn,
  ToolStartingDecision,
  ToolTimeSpan,
  ToolView,
} from './types';
import { toolArgsError } from './validate';

type AnyTool<TContext> = ExecutableTool<any, TContext, any, any>;
type AnyHandler = ToolExecutionHandler<any, any>;

export class ToolExecutor<TContext = unknown> {
  private readonly tools: Map<string, AnyTool<TContext>>;
  private readonly policy: ToolExecutorPolicy<TContext, any>;
  private readonly outputStore: ToolOutputStore;

  constructor(
    tools: readonly AnyTool<TContext>[],
    policy: ToolExecutorPolicy<TContext, any> = {},
  ) {
    for (const tool of tools) assertToolName(tool.name);
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.policy = policy;
    this.outputStore = policy.outputStore ?? memoryOutputStore();
  }

  list(): AnyTool<TContext>[] {
    return [...this.tools.values()];
  }

  addExecute(tool: AnyTool<TContext>): void {
    assertToolName(tool.name);
    this.tools.set(tool.name, tool);
  }

  removeExecute(tool: AnyTool<TContext>): boolean {
    if (this.tools.get(tool.name) !== tool) return false;
    return this.tools.delete(tool.name);
  }

  execute(call: ToolCall, context: TContext): AnyHandler {
    const hook = this.policy.hook;
    const control = new CallControl<TContext>(
      call,
      generateTaskId(call.name),
      this.outputStore,
      { now: this.policy.now ?? defaultNow, tick: this.policy.tick ?? defaultTick },
      (snapshot, reason) => this.detached(call, snapshot, reason),
    );
    const decisionContext = (): ToolDecisionContext<unknown, TContext, any> => ({
      call,
      taskId: control.taskId,
      args: control.args,
      context,
      signal: control.signal,
      prepared: control.prepared,
    });
    const decide = async <T extends ToolDecision | ToolStartingDecision>(
      phase: ToolPhase,
      decider: (
        context: ToolDecisionContext<unknown, TContext, any>,
      ) => T | void | Promise<T | void>,
    ): Promise<T | void> => {
      control.enter(phase);
      const decision = await decider(decisionContext());
      control.signal.throwIfAborted();
      if (decision === undefined) return;
      if ('reject' in decision) {
        throw new ToolStop(rejected(phase, decision.reject, decision.data), decision.result);
      }
      if ('args' in decision) control.setArgs(decision.args);
      return decision;
    };
    const prepare = async (tool: AnyTool<TContext>): Promise<ToolReturn | undefined> => {
      control.enter('validate');
      const validation = toolArgsError(tool, control.args);
      if (validation !== null) {
        throw new ToolStop(rejected('validate', `Invalid args for tool "${tool.name}": ${validation}`));
      }
      control.enter('resolve');
      const preparation = await tool.prepare?.({
        call,
        taskId: control.taskId,
        args: control.args,
        context,
        signal: control.signal,
      });
      control.setPrepared(preparation?.prepared);
      control.signal.throwIfAborted();
      return preparation?.type === 'synthetic' ? preparation.result : undefined;
    };

    const run = async (): Promise<ToolResult> => {
      try {
        const tool = this.tools.get(call.name);
        control.enter('parse');
        const parsed = parseToolCallArguments(call.arguments);
        if (parsed.parseFailed) {
          throw new ToolStop(rejected(
            'parse',
            `Invalid args for tool "${call.name}": ${parsed.error ?? 'Malformed JSON'}`,
            parsed.error,
          ));
        }
        control.setArgs(parsed.data);
        if (tool === undefined) {
          throw new ToolStop(rejected('resolve', `Tool "${call.name}" not found`, undefined, 'resolve'));
        }
        const validating = await decide('validate', (ctx) => hook?.validating?.(ctx));
        if (validating !== undefined && 'args' in validating) {
          const rewritten = await prepare(tool);
          if (rewritten !== undefined) return control.returned(rewritten);
        }
        const synthetic = await prepare(tool);
        if (synthetic !== undefined) return control.returned(synthetic);
        if (tool.execute === undefined) {
          throw new ToolStop(rejected(
            'resolve',
            `Tool "${call.name}" has no execute function`,
            undefined,
            'resolve',
          ));
        }
        const starting = await decide('starting', (ctx) => hook?.starting?.(ctx));
        if (starting !== undefined && 'args' in starting) {
          const rewritten = await prepare(tool);
          if (rewritten !== undefined) return control.returned(rewritten);
        }
        if (starting === undefined || !('skipPermitting' in starting)) {
          const permitting = await decide('permitting', (ctx) => hook?.permitting?.(ctx));
          if (permitting !== undefined && 'args' in permitting) {
            const rewritten = await prepare(tool);
            if (rewritten !== undefined) return control.returned(rewritten);
          }
        }
        control.enter('before-execute');
        await hook?.beforeExecute?.(decisionContext());
        control.signal.throwIfAborted();
        control.startExecution();
        control.use(tool);
        const toolContext: ToolExecuteContext<unknown, TContext, any, any> = {
          ...decisionContext(),
          ...control.view,
          detach: (reason, acknowledgement) => control.detach(reason, acknowledgement),
          onDetach: (acknowledge) => control.onDetach(acknowledge),
          write: (text) => control.write(text),
          flush: () => control.flush(),
          set: (fields) => control.set(fields),
        };
        let returned: ToolReturn;
        try {
          returned = await tool.execute(toolContext);
        } finally {
          control.settleExecution();
        }
        return control.returned(returned);
      } catch (thrown) {
        if (thrown instanceof ToolStop && thrown.result !== undefined) {
          return control.returned(thrown.result, thrown.error);
        }
        const currentTool = this.tools.get(call.name);
        if (control.wasStopped() && currentTool !== undefined) control.use(currentTool);
        const error = control.wasStopped()
          ? abortedError(control.call, control.phase, 'stopped', control.stopCause())
          : toToolError(control, thrown);
        if (isPreExecutionHookError(error)) throw preExecutionHookFailure(error);
        return this.fail(control, error);
      }
    };

    const completion = (async (): Promise<ToolResult> => {
      try {
        let result = await Promise.race([run(), control.abandonment]);
        control.seal();
        const outputError = await control.closeOutput();
        if (outputError !== undefined && result.outcome.type !== 'aborted') {
          result = this.fail(control, {
            outcome: 'failed',
            type: 'output',
            phase: control.phase,
            reason: `Tool "${call.name}" output failed: ${outputError}`,
            data: outputError,
          });
        }
        control.enter('after-execute');
        try {
          const hookContext: AfterExecuteHookContext<unknown, TContext, any> = {
            ...decisionContext(),
            get fields() {
              return control.fields();
            },
            result,
            set: (fields) => control.update(fields),
          };
          const replaced = await hook?.afterExecute?.(hookContext);
          if (replaced !== undefined) result = reconcile(result, replaced, call.id);
        } catch (thrown) {
          const thrownError = toToolError(control, thrown);
          const failed = this.fail(control, thrownError);
          result = result.outcome.type === 'aborted'
            ? { ...failed, outcome: result.outcome }
            : failed;
        }
        return result;
      } catch (thrown) {
        const error = toToolError(control, thrown);
        if (isPreExecutionHookError(error)) throw preExecutionHookFailure(error);
        return control.errorResult(error, [{ type: 'text', text: error.reason }]);
      }
    })();

    const handler = control.handle(completion);
    if (hook?.observe !== undefined) {
      const emit = (event: ToolExecutionEvent<any, any, any>): void => {
        try {
          hook.observe?.(event);
        } catch {
          return;
        }
      };
      control.observe((event) => emit({ call, context, handler, ...event }));
      emit({ call, context, handler, type: 'created' });
    }
    return handler;
  }

  private fail(control: CallControl<TContext>, error: ToolError): ToolResult {
    const content = this.policy.renderError?.(control.call, error) ?? [{ type: 'text', text: error.reason }];
    return control.errorResult(error, content);
  }

  private detached(
    call: ToolCall,
    snapshot: ToolExecutionSnapshot<any, any>,
    reason: unknown,
  ): ToolAcknowledgement {
    return this.policy.detached?.(call, snapshot, reason) ?? {
      content: [
        {
          type: 'text',
          text: [
            `Tool "${call.name}" moved to the background.`,
            `task_id: ${snapshot.taskId}`,
            `phase: ${snapshot.phase}`,
          ].join('\n'),
        },
      ],
    };
  }
}

export function isToolDetachAck(value: ToolExecutionResponse): value is ToolDetachAck {
  return 'detached' in value && value.detached === true;
}

function isPreExecutionHookError(error: ToolError): boolean {
  return error.outcome === 'failed' &&
    error.type === 'unknown' &&
    (error.phase === 'starting' || error.phase === 'before-execute');
}

export function textToolContent(text: string): ContentPart[] {
  return [{ type: 'text', text }];
}

export function defaultNow(): number {
  return Date.now();
}

export function defaultTick(): number {
  return performance.now();
}

interface ToolClock {
  now(): number;
  tick(): number;
}

const EMPTY_OUTPUT: ToolOutputSnapshot = {
  totalBytes: 0,
  preview: '',
  truncated: false,
};

class TimeSpan {
  private readonly clock: ToolClock;
  private readonly startedAt: number;
  private readonly startedTick: number;
  private endedAt: number | null = null;
  private elapsedMs: number | undefined;

  constructor(clock: ToolClock) {
    this.clock = clock;
    this.startedAt = clock.now();
    this.startedTick = clock.tick();
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  end(): void {
    if (this.endedAt !== null) return;
    this.endedAt = this.clock.now();
    this.elapsedMs = Math.max(0, this.clock.tick() - this.startedTick);
  }

  snapshot(): ToolTimeSpan {
    return {
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsedMs ?? Math.max(0, this.clock.tick() - this.startedTick),
    };
  }
}

class CallControl<TContext> {
  readonly call: ToolCall;
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly view: ToolView<any, any>;
  readonly abandonment: Promise<ToolResult>;
  prepared: any;
  private readonly store: ToolOutputStore;
  private readonly clock: ToolClock;
  private readonly abortController = new AbortController();
  private readonly total: TimeSpan;
  private execution: TimeSpan | undefined;
  private log: ToolOutput | undefined;
  private currentPhase: ToolPhase = 'resolve';
  private currentArgs: unknown;
  private outcome: ToolOutcome | undefined;
  private structured: Record<string, unknown> = {};
  private stopping: ((reason: unknown) => void) | undefined;
  private responseSettled = false;
  private stopped: { readonly reason: unknown } | undefined;
  private abandoned = false;
  private detachedAck: ToolDetachAck | undefined;
  private detachAck: ((reason: unknown) => ToolAcknowledgement) | undefined;
  private readonly defaultDetachAck: (
    snapshot: ToolExecutionSnapshot<any, any>,
    reason: unknown,
  ) => ToolAcknowledgement;
  private acknowledge: ((result: ToolExecutionResponse) => void) | undefined;
  private release: (result: ToolResult) => void = () => {};
  private readonly listeners = new Set<(event: ToolHandlerEvent<any, any>) => void>();
  private closeError: string | undefined;
  private hasPrepared = false;

  constructor(
    call: ToolCall,
    taskId: string,
    store: ToolOutputStore,
    clock: ToolClock,
    defaultDetachAck: (
      snapshot: ToolExecutionSnapshot<any, any>,
      reason: unknown,
    ) => ToolAcknowledgement,
  ) {
    this.call = call;
    this.taskId = taskId;
    this.store = store;
    this.clock = clock;
    this.defaultDetachAck = defaultDetachAck;
    this.signal = this.abortController.signal;
    this.total = new TimeSpan(clock);
    this.view = {
      snapshot: () => this.snapshot(),
      output: (maxPreviewBytes) => this.output(maxPreviewBytes),
      fields: () => this.fields(),
    };
    this.abandonment = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  get phase(): ToolPhase {
    return this.currentPhase;
  }

  get args(): unknown {
    return this.currentArgs;
  }

  observe(listener: (event: ToolHandlerEvent<any, any>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enter(phase: ToolPhase): void {
    if (this.currentPhase === phase) return;
    this.change(() => {
      this.currentPhase = phase;
    });
  }

  setArgs(args: unknown): void {
    this.change(() => {
      this.currentArgs = args;
    });
  }

  setPrepared(prepared: unknown): void {
    this.change(() => {
      this.prepared = prepared;
      this.hasPrepared = true;
    });
  }

  startExecution(): void {
    this.change(() => {
      this.currentPhase = 'execute';
      this.execution = new TimeSpan(this.clock);
    });
  }

  write(text: string): number | undefined {
    if (text.length === 0 || this.frozen) return undefined;
    const log = this.outputLog();
    const offset = log.append(text);
    if (offset !== undefined && log.onAppend === undefined) this.emit({ type: 'output', offset, text });
    return offset;
  }

  private outputLog(): ToolOutput {
    if (this.log === undefined) {
      this.log = this.store.open(this.taskId);
      this.log.onAppend?.((chunk, offset) => {
        this.emit({ type: 'output', offset, text: chunk });
      });
    }
    return this.log;
  }

  set(fields: object): void {
    if (this.frozen) return;
    this.update(fields);
  }

  update(fields: object): void {
    this.change(() => {
      Object.assign(this.structured, fields);
    });
  }

  fields(): Readonly<Record<string, unknown>> {
    return { ...this.structured };
  }

  output(maxPreviewBytes?: number): ToolOutputSnapshot {
    return this.log?.preview(maxPreviewBytes) ?? EMPTY_OUTPUT;
  }

  async flush(): Promise<void> {
    await this.log?.flush();
  }

  async closeOutput(): Promise<string | undefined> {
    if (this.log === undefined) return undefined;
    try {
      await this.log.close();
    } catch (error) {
      this.closeError = errorMessage(error);
    }
    return this.closeError ?? this.log.error();
  }

  snapshot(): ToolExecutionSnapshot<any, any> {
    const stopReason = this.stopped === undefined ? undefined : stopReasonText(this.stopped.reason);
    const outputError = this.closeError ?? this.log?.error();
    const error = this.outcome !== undefined && this.outcome.type !== 'success'
      ? this.outcome.error
      : undefined;
    return {
      id: this.call.id,
      taskId: this.taskId,
      name: this.call.name,
      status: this.outcome?.type ?? (this.stopped === undefined ? 'running' : 'stopping'),
      phase: this.currentPhase,
      args: this.currentArgs,
      timing: {
        total: this.total.snapshot(),
        execute: this.execution?.snapshot() ?? null,
      },
      detached: this.detachedAck !== undefined,
      fields: this.fields(),
      prepared: this.hasPrepared ? this.prepared : undefined,
      error,
      stopReason,
      outputError,
    };
  }

  use(tool: AnyTool<TContext>): void {
    const hadStopping = this.stopping !== undefined;
    if (typeof tool.stopping === 'function') {
      const stopping = tool.stopping.bind(tool);
      this.stopping = (reason) => stopping({
        ...this.view,
        reason,
        abandon: (result) => this.abandon(result),
      });
    }
    if (!hadStopping && this.stopped !== undefined && this.stopping !== undefined) {
      try {
        this.stopping(this.stopped.reason);
      } catch {
      }
    }
  }

  onDetach(acknowledge: (reason: unknown) => ToolAcknowledgement): void {
    if (this.execution === undefined || this.execution.ended) return;
    this.detachAck = acknowledge;
  }

  seal(): void {
    this.responseSettled = true;
    this.stopping = undefined;
    this.detachAck = undefined;
    this.execution?.end();
  }

  settleExecution(): void {
    this.seal();
  }

  returned(value: ToolReturn, cause?: ToolError): ToolResult {
    if (this.stopped !== undefined) {
      const outcome: ToolOutcome = {
        type: 'aborted',
        error: abortedError(this.call, this.currentPhase, 'stopped', this.stopped.reason),
      };
      return { toolCallId: this.call.id, content: value.content, outcome };
    }
    if (cause !== undefined) return this.errorResult(cause, value.content);
    if (value.outcome === 'failed') {
      const error: ToolError = {
        outcome: 'failed',
        type: value.subtype ?? 'error',
        phase: 'execute',
        reason: value.reason,
        data: value.data,
      };
      return { toolCallId: this.call.id, content: value.content, outcome: { type: 'failed', error } };
    }
    return { toolCallId: this.call.id, content: value.content, outcome: { type: 'success' } };
  }

  errorResult(error: ToolError, content: ContentPart[]): ToolResult {
    return {
      toolCallId: this.call.id,
      content,
      outcome: error.outcome === 'failed' ? { type: 'failed', error } : { type: 'aborted', error },
    };
  }

  wasStopped(): boolean {
    return this.stopped !== undefined;
  }

  stopCause(): unknown {
    return this.stopped?.reason;
  }

  remember(outcome: ToolOutcome): void {
    this.outcome = outcome;
  }

  requestStop(reason?: unknown): void {
    if (this.stopped !== undefined || this.responseSettled) return;
    this.change(() => {
      this.stopped = { reason };
    });
    this.abortController.abort(reason);
    const stopping = this.stopping;
    if (stopping === undefined) return;
    try {
      stopping(reason);
    } catch {
      return;
    }
  }

  private get frozen(): boolean {
    return this.abandoned || this.responseSettled || this.outcome !== undefined;
  }

  private abandon(value?: ToolReturn): void {
    if (
      this.stopped === undefined ||
      this.stopping === undefined ||
      this.abandoned ||
      this.responseSettled
    ) return;
    this.abandoned = true;
    const error = abortedError(this.call, this.currentPhase, 'abandoned', this.stopped.reason);
    const result = value === undefined
      ? this.errorResult(error, [{ type: 'text', text: error.reason }])
      : { toolCallId: this.call.id, content: value.content, outcome: { type: 'aborted', error } as ToolOutcome };
    this.release(result);
  }

  detach(reason?: unknown, provided?: ToolAcknowledgement): ToolDetachAck | undefined {
    if (
      this.responseSettled ||
      this.signal.aborted ||
      this.detachedAck !== undefined ||
      this.outcome !== undefined
    ) {
      return this.detachedAck;
    }
    let acknowledgement: ToolAcknowledgement;
    try {
      acknowledgement = provided ?? this.detachAck?.(reason) ?? this.defaultDetachAck(this.snapshot(), reason);
    } catch {
      acknowledgement = this.defaultDetachAck(this.snapshot(), reason);
    }
    const detached: ToolDetachAck = {
      detached: true,
      taskId: this.taskId,
      toolCallId: this.call.id,
      content: acknowledgement.content,
      brief: acknowledgement.brief,
    };
    this.change(() => {
      this.detachedAck = detached;
    });
    this.acknowledge?.(detached);
    return detached;
  }

  handle(completion: Promise<ToolResult>): AnyHandler {
    const settled = (async (): Promise<ToolResult> => {
      const result = await completion;
      this.change(() => {
        this.remember(result.outcome);
        this.total.end();
        this.execution?.end();
      });
      return result;
    })();
    const returned = new Promise<ToolExecutionResponse>((resolve, reject) => {
      this.acknowledge = resolve;
      if (this.detachedAck !== undefined) resolve(this.detachedAck);
      settled.then(resolve, reject);
    });
    const wait = (timeoutMs?: number, signal?: AbortSignal): Promise<ToolResult> => {
      if (timeoutMs === undefined && signal === undefined) return settled;
      if (this.outcome !== undefined) return settled;
      if (signal?.aborted === true) return Promise.reject(signal.reason);
      const delay = timeoutMs !== undefined && Number.isFinite(timeoutMs)
        ? Math.min(Math.max(0, timeoutMs), 2_147_483_647)
        : undefined;
      return new Promise<ToolResult>((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abortSignal = signal;
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
        };
        const finish = (complete: () => void): void => {
          if (done) return;
          done = true;
          cleanup();
          complete();
        };
        const onAbort = (): void => finish(() => reject(abortSignal?.reason));
        if (delay !== undefined) {
          timer = setTimeout(() => finish(() => reject(new ToolTimeoutError(delay))), delay);
          timer.unref?.();
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        settled.then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    };
    const handler: Omit<AnyHandler, 'then'> = {
      taskId: this.taskId,
      wait,
      stop: (reason) => {
        if (this.outcome === undefined) this.requestStop(reason);
        return settled;
      },
      detach: (reason, acknowledgement) => this.detach(reason, acknowledgement),
      snapshot: () => this.snapshot(),
      output: (maxPreviewBytes?: number) => this.output(maxPreviewBytes),
      fields: () => this.fields(),
      observe: (listener) => this.observe(listener),
    };
    return Object.assign(returned, handler);
  }

  private change(apply: () => void): void {
    if (this.listeners.size === 0) {
      apply();
      return;
    }
    const previous = this.snapshot();
    apply();
    this.emit({ type: 'change', previous, snapshot: this.snapshot() });
  }

  private emit(event: ToolHandlerEvent<any, any>): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }
}

class ToolStop extends Error {
  readonly error: ToolError;
  readonly result: ToolReturn | undefined;

  constructor(error: ToolError, result?: ToolReturn) {
    super(error.reason);
    this.name = 'ToolStop';
    this.error = error;
    this.result = result;
  }
}

function preExecutionHookFailure(error: ToolError): Error {
  return error.data instanceof Error ? error.data : new Error(error.reason, { cause: error.data });
}

function toToolError(
  control: {
    readonly call: ToolCall;
    readonly phase: ToolPhase;
    readonly signal: AbortSignal;
    readonly wasStopped: () => boolean;
    readonly stopCause: () => unknown;
  },
  thrown: unknown,
): ToolError {
  if (thrown instanceof ToolStop) return thrown.error;
  if (control.wasStopped()) {
    return abortedError(control.call, control.phase, 'stopped', control.stopCause());
  }
  const phase = control.phase;
  const reason = phase === 'execute'
    ? `Tool "${control.call.name}" failed: ${errorMessage(thrown)}`
    : phase === 'resolve'
      ? `Tool "${control.call.name}" failed to resolve execution: ${errorMessage(thrown)}`
      : `${phase} hook failed for "${control.call.name}": ${errorMessage(thrown)}`;
  return {
    outcome: 'failed',
    type: phase === 'resolve' ? 'resolve' : 'unknown',
    phase,
    reason,
    data: thrown,
  };
}

function abortedError(
  call: ToolCall,
  phase: ToolPhase,
  type: ToolAbortType,
  reason: unknown,
): Extract<ToolError, { outcome: 'aborted' }> {
  const error: Extract<ToolError, { outcome: 'aborted' }> = {
    outcome: 'aborted',
    type,
    phase,
    reason: describeAbort(call, reason),
  };
  return reason === undefined ? error : { ...error, data: reason };
}

function rejected(
  phase: ToolPhase,
  reason: string,
  data?: unknown,
  type: 'invalid' | 'rejected' | 'resolve' = phase === 'parse' || phase === 'validate' ? 'invalid' : 'rejected',
): ToolError {
  const error: ToolError = { outcome: 'failed', type, phase, reason };
  return data === undefined ? error : { ...error, data };
}

function reconcile(previous: ToolResult, replacement: ToolResult, toolCallId: string): ToolResult {
  return {
    ...replacement,
    toolCallId,
    outcome: previous.outcome.type === 'aborted' ? previous.outcome : replacement.outcome,
  };
}

function describeAbort(call: ToolCall, reason: unknown): string {
  if (isUserCancellation(reason)) return abortedToolOutput(call.name, reason);
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason.message;
  return abortedToolOutput(call.name, reason);
}

function assertToolName(name: string): void {
  if (name.trim() === '') throw new TypeError('tool name must be a non-empty string');
}

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function generateTaskId(name: string): string {
  const prefix = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < bytes.length; index += 1) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${prefix === '' ? 'task' : prefix}-${suffix}`;
}

function stopReasonText(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
