import { randomBytes } from 'node:crypto';

import type { ContentPart } from '#/llm/message';
import { isPromiseLike } from '#/hook/result';
import { abortedToolOutput, isUserCancellation } from '#/utils/abort';
import { clock } from '#/utils/clock';
import { log, type LogContext } from '#/utils/log';
import { now } from '#/utils/now';
import { applyToolArgAliases, parseToolCallArguments } from '#/tool/args';

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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

interface CallControlHost<TContext> {
  readonly outputStore: ToolOutputStore;
  readonly hook: ToolExecutorPolicy<TContext, any>['hook'];
  resolveTool(name: string): AnyTool<TContext> | undefined;
  renderError(call: ToolCall, error: ToolError): ContentPart[];
  detachAck(snapshot: ToolExecutionSnapshot<any, any>, reason: unknown): ToolAcknowledgement;
}

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
    const host: CallControlHost<TContext> = {
      outputStore: this.outputStore,
      hook: this.policy.hook,
      resolveTool: (name) => this.tools.get(name),
      renderError: (toolCall, error) => this.renderError(toolCall, error),
      detachAck: (snapshot, reason) => this.detached(call, snapshot, reason),
    };
    return new CallControl(call, context, host).start();
  }

  private renderError(call: ToolCall, error: ToolError): ContentPart[] {
    return this.policy.renderError?.(call, error) ?? [{ type: 'text', text: error.reason }];
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

const EMPTY_OUTPUT: ToolOutputSnapshot = {
  totalBytes: 0,
  preview: '',
  truncated: false,
};

class TimeSpan {
  private readonly startedAt = now();
  private readonly startedTick = clock();
  private endedAt: number | null = null;
  private elapsedMs: number | undefined;

  get ended(): boolean {
    return this.endedAt !== null;
  }

  end(): void {
    if (this.endedAt !== null) return;
    this.endedAt = now();
    this.elapsedMs = Math.max(0, clock() - this.startedTick);
  }

  snapshot(): ToolTimeSpan {
    return {
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsedMs ?? Math.max(0, clock() - this.startedTick),
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
  private readonly context: TContext;
  private readonly host: CallControlHost<TContext>;
  private readonly store: ToolOutputStore;
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
  private readonly detachment = deferred<ToolDetachAck>();
  private release: (result: ToolResult) => void = () => {};
  private readonly listeners = new Set<(event: ToolHandlerEvent<any, any>) => void>();
  private closeError: string | undefined;
  private hasPrepared = false;

  constructor(call: ToolCall, context: TContext, host: CallControlHost<TContext>) {
    this.call = call;
    this.context = context;
    this.host = host;
    this.taskId = generateTaskId(call.name);
    this.store = host.outputStore;
    this.signal = this.abortController.signal;
    this.total = new TimeSpan();
    this.view = {
      snapshot: () => this.snapshot(),
      output: (maxPreviewBytes) => this.output(maxPreviewBytes),
      fields: () => this.fields(),
    };
    this.abandonment = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  start(): AnyHandler {
    const hook = this.host.hook;
    log.info(this.logContext('tool.started'), 'tool event');
    const completion = this.complete();
    const response: Promise<ToolExecutionResponse> = Promise.race([completion, this.detachment.promise]);
    const methods: Omit<AnyHandler, 'then'> = {
      taskId: this.taskId,
      wait: (timeoutMs, signal) => this.wait(completion, timeoutMs, signal),
      stop: (reason) => {
        if (this.outcome === undefined) this.requestStop(reason);
        return completion;
      },
      detach: (reason, acknowledgement) => this.detach(reason, acknowledgement),
      snapshot: () => this.snapshot(),
      output: (maxPreviewBytes?: number) => this.output(maxPreviewBytes),
      fields: () => this.fields(),
      observe: (listener) => this.observe(listener),
    };
    const handler = Object.assign(response, methods);
    if (hook?.observe !== undefined) {
      const emit = (event: ToolExecutionEvent<any, any, any>): void => {
        try {
          hook.observe?.(event);
        } catch (error) {
          log.warn({
            ...this.logContext('tool.observer_failed'),
            source: 'policy',
            eventType: event.type,
            reason: errorMessage(error),
          }, 'tool event');
          return;
        }
      };
      this.observe((event) => emit({ call: this.call, context: this.context, handler, ...event }));
      emit({ call: this.call, context: this.context, handler, type: 'created' });
    }
    return handler;
  }

  private async complete(): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = await Promise.race([this.run(), this.abandonment]);
      this.seal();
      const outputError = await this.closeOutput();
      if (outputError !== undefined && result.outcome.type !== 'aborted') {
        const failure = this.fail({
          outcome: 'failed',
          type: 'output',
          phase: this.phase,
          reason: `Tool "${this.call.name}" output failed: ${outputError}`,
          data: outputError,
        });
        result = result.durationMs === undefined ? failure : { ...failure, durationMs: result.durationMs };
      }
      this.enter('after-execute');
      try {
        const fields = (): Readonly<Record<string, unknown>> => this.fields();
        const hookContext: AfterExecuteHookContext<unknown, TContext, any> = {
          ...this.decisionContext(),
          get fields() {
            return fields();
          },
          result,
          set: (fields) => this.update(fields),
        };
        const replaced = await this.host.hook?.afterExecute?.(hookContext);
        if (replaced !== undefined) result = reconcile(result, replaced, this.call.id);
      } catch (thrown) {
        const thrownError = toToolError(this, thrown);
        const failed = this.fail(thrownError);
        const settled = result.outcome.type === 'aborted' ? { ...failed, outcome: result.outcome } : failed;
        result = result.durationMs === undefined ? settled : { ...settled, durationMs: result.durationMs };
      }
    } catch (thrown) {
      const error = toToolError(this, thrown);
      if (isPreExecutionHookError(error)) {
        const failure = preExecutionHookFailure(error);
        log.error({
          ...this.logContext('tool.failed'),
          reason: errorMessage(failure),
        }, 'tool execution failed');
        throw failure;
      }
      result = this.errorResult(error, [{ type: 'text', text: error.reason }]);
    }
    this.change(() => {
      this.remember(result.outcome);
      this.total.end();
      this.execution?.end();
    });
    this.logResult(result);
    return result;
  }

  private async run(): Promise<ToolResult> {
    try {
      const tool = this.host.resolveTool(this.call.name);
      this.enter('parse');
      const parsed = parseToolCallArguments(this.call.arguments);
      if (parsed.parseFailed) {
        throw new ToolStop(rejected(
          'parse',
          `Invalid args for tool "${this.call.name}": ${parsed.error ?? 'Malformed JSON'}`,
          parsed.error,
        ));
      }
      this.setArgs(applyToolArgAliases(tool?.argAliases, parsed.data));
      if (tool === undefined) {
        throw new ToolStop(rejected('resolve', `Tool "${this.call.name}" not found`, undefined, 'resolve'));
      }
      const validating = this.decide('validate', (ctx) => this.host.hook?.validating?.(ctx));
      if (isPromiseLike(validating)) await validating;
      const synthetic = await this.prepare(tool);
      if (synthetic !== undefined) return this.returned(synthetic);
      if (tool.execute === undefined) {
        throw new ToolStop(rejected(
          'resolve',
          `Tool "${this.call.name}" has no execute function`,
          undefined,
          'resolve',
        ));
      }
      const starting = await this.decide('starting', (ctx) => this.host.hook?.starting?.(ctx));
      if (starting !== undefined && 'args' in starting) {
        const rewritten = await this.prepare(tool);
        if (rewritten !== undefined) return this.returned(rewritten);
      }
      if (starting !== undefined && 'skipPermitting' in starting) {
        log.debug(this.logContext('tool.permitting_skipped'), 'tool event');
      }
      if (starting === undefined || !('skipPermitting' in starting)) {
        const permitting = await this.decide('permitting', (ctx) => this.host.hook?.permitting?.(ctx));
        if (permitting !== undefined && 'args' in permitting) {
          const rewritten = await this.prepare(tool);
          if (rewritten !== undefined) return this.returned(rewritten);
        }
      }
      this.enter('before-execute');
      await this.host.hook?.beforeExecute?.(this.decisionContext());
      this.signal.throwIfAborted();
      this.startExecution();
      this.use(tool);
      const toolContext: ToolExecuteContext<unknown, TContext, any, any> = {
        ...this.decisionContext(),
        ...this.view,
        detach: (reason, acknowledgement) => this.detach(reason, acknowledgement),
        onDetach: (acknowledge) => this.onDetach(acknowledge),
        write: (text) => this.write(text),
        flush: () => this.flush(),
        set: (fields) => this.set(fields),
      };
      let returned: ToolReturn;
      try {
        returned = await tool.execute(toolContext);
      } finally {
        this.settleExecution();
      }
      return this.returned(returned);
    } catch (thrown) {
      if (thrown instanceof ToolStop && thrown.result !== undefined) {
        return this.returned(thrown.result, thrown.error);
      }
      const currentTool = this.host.resolveTool(this.call.name);
      if (this.wasStopped() && currentTool !== undefined) this.use(currentTool);
      const error = this.wasStopped()
        ? abortedError(this.call, this.phase, 'stopped', this.stopCause())
        : toToolError(this, thrown);
      if (isPreExecutionHookError(error)) throw preExecutionHookFailure(error);
      return this.fail(error);
    }
  }

  private decide<T extends ToolDecision | ToolStartingDecision>(
    phase: ToolPhase,
    decider: (
      context: ToolDecisionContext<unknown, TContext, any>,
    ) => T | void | Promise<T | void>,
  ): T | void | Promise<T | void> {
    this.enter(phase);
    const returned = decider(this.decisionContext());
    if (isPromiseLike(returned)) {
      return (returned as Promise<T | void>).then((decision) => this.applyDecision<T>(phase, decision));
    }
    return this.applyDecision<T>(phase, returned as T | void);
  }

  private applyDecision<T extends ToolDecision | ToolStartingDecision>(
    phase: ToolPhase,
    decision: T | void,
  ): T | void {
    this.signal.throwIfAborted();
    if (decision === undefined) return;
    if ('reject' in decision) {
      log.info({
        ...this.logContext('tool.rejected'),
        reason: decision.reject,
        synthetic: decision.result !== undefined,
      }, 'tool event');
      throw new ToolStop(rejected(phase, decision.reject, decision.data), decision.result);
    }
    if ('args' in decision) {
      log.debug(this.logContext('tool.args_rewritten'), 'tool event');
      this.setArgs(decision.args);
    }
    return decision;
  }

  private async prepare(tool: AnyTool<TContext>): Promise<ToolReturn | undefined> {
    this.enter('validate');
    const validation = toolArgsError(tool, this.args);
    if (validation !== null) {
      throw new ToolStop(rejected('validate', `Invalid args for tool "${tool.name}": ${validation}`));
    }
    this.enter('resolve');
    const preparation = await tool.prepare?.({
      call: this.call,
      taskId: this.taskId,
      args: this.args,
      context: this.context,
      signal: this.signal,
    });
    this.setPrepared(preparation?.prepared);
    this.signal.throwIfAborted();
    if (preparation?.type !== 'synthetic') return undefined;
    log.info(this.logContext('tool.synthetic'), 'tool event');
    return preparation.result;
  }

  private logContext(type: string): LogContext {
    return {
      type,
      taskId: this.taskId,
      toolCallId: this.call.id,
      name: this.call.name,
      phase: this.currentPhase,
    };
  }

  private logResult(result: ToolResult): void {
    const details = {
      ...this.logContext('tool.ended'),
      outcome: result.outcome.type,
      elapsedMs: this.total.snapshot().elapsedMs,
      executeElapsedMs: this.execution?.snapshot().elapsedMs,
    };
    if (result.outcome.type === 'failed') {
      log.error({
        ...details,
        error: {
          type: result.outcome.error.type,
          phase: result.outcome.error.phase,
          reason: result.outcome.error.reason,
        },
      }, 'tool execution failed');
      return;
    }
    log.info(details, 'tool event');
  }

  private decisionContext(): ToolDecisionContext<unknown, TContext, any> {
    return {
      call: this.call,
      taskId: this.taskId,
      args: this.args,
      context: this.context,
      signal: this.signal,
      prepared: this.prepared,
    };
  }

  private fail(error: ToolError): ToolResult {
    const content = this.host.renderError(this.call, error);
    return this.errorResult(error, content);
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
    const previousPhase = this.currentPhase;
    this.change(() => {
      this.currentPhase = phase;
    });
    log.debug({ ...this.logContext('tool.phase'), previousPhase }, 'tool event');
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
      this.execution = new TimeSpan();
    });
    log.info(this.logContext('tool.execute'), 'tool event');
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
      log.warn({
        ...this.logContext('tool.output_close_failed'),
        reason: this.closeError,
      }, 'tool event');
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
        abandon: (result, durationMs) => this.abandon(result, durationMs),
      });
    }
    if (!hadStopping && this.stopped !== undefined && this.stopping !== undefined) {
      try {
        this.stopping(this.stopped.reason);
      } catch (error) {
        log.warn({
          ...this.logContext('tool.stopping_failed'),
          reason: errorMessage(error),
        }, 'tool event');
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
      return { toolCallId: this.call.id, content: value.content, outcome, ...durationPart(value.durationMs) };
    }
    if (cause !== undefined) {
      return { ...this.errorResult(cause, value.content), ...durationPart(value.durationMs) };
    }
    if (value.outcome === 'failed') {
      const error: ToolError = {
        outcome: 'failed',
        type: value.subtype ?? 'error',
        phase: 'execute',
        reason: value.reason,
        data: value.data,
      };
      return {
        toolCallId: this.call.id,
        content: value.content,
        outcome: { type: 'failed', error },
        ...durationPart(value.durationMs),
      };
    }
    return { toolCallId: this.call.id, content: value.content, outcome: { type: 'success' }, ...durationPart(value.durationMs) };
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
    log.info({
      ...this.logContext('tool.stopping'),
      reason: stopReasonText(reason),
    }, 'tool event');
    this.abortController.abort(reason);
    const stopping = this.stopping;
    if (stopping === undefined) return;
    try {
      stopping(reason);
    } catch (error) {
      log.warn({
        ...this.logContext('tool.stopping_failed'),
        reason: errorMessage(error),
      }, 'tool event');
      return;
    }
  }

  private get frozen(): boolean {
    return this.abandoned || this.responseSettled || this.outcome !== undefined;
  }

  private abandon(value?: ToolReturn, durationMs?: number): void {
    if (
      this.stopped === undefined ||
      this.stopping === undefined ||
      this.abandoned ||
      this.responseSettled
    ) return;
    this.abandoned = true;
    log.warn({
      ...this.logContext('tool.abandoned'),
      reason: stopReasonText(this.stopped.reason),
    }, 'tool event');
    const error = abortedError(this.call, this.currentPhase, 'abandoned', this.stopped.reason);
    const measured = durationMs ?? value?.durationMs;
    const result = value === undefined
      ? { ...this.errorResult(error, [{ type: 'text', text: error.reason }]), ...durationPart(measured) }
      : {
          toolCallId: this.call.id,
          content: value.content,
          outcome: { type: 'aborted', error } as ToolOutcome,
          ...durationPart(measured),
        };
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
      acknowledgement = provided ?? this.detachAck?.(reason) ?? this.host.detachAck(this.snapshot(), reason);
    } catch (error) {
      log.warn({
        ...this.logContext('tool.detach_ack_failed'),
        reason: errorMessage(error),
      }, 'tool event');
      acknowledgement = this.host.detachAck(this.snapshot(), reason);
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
    log.info(this.logContext('tool.detached'), 'tool event');
    this.detachment.resolve(detached);
    return detached;
  }

  private wait(
    completion: Promise<ToolResult>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (timeoutMs === undefined && signal === undefined) return completion;
    if (this.outcome !== undefined) return completion;
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
      completion.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
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
    if (event.type === 'output') {
      log.debug({
        ...this.logContext('tool.output'),
        offset: event.offset,
        characters: event.text.length,
      }, 'tool event');
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        log.warn({
          ...this.logContext('tool.observer_failed'),
          source: 'handler',
          eventType: event.type,
          reason: errorMessage(error),
        }, 'tool event');
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

function durationPart(durationMs: number | undefined): { readonly durationMs?: number } {
  return durationMs === undefined ? {} : { durationMs };
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
