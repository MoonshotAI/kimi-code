import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type {
  ExecutableTool as LegacyExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolAccesses,
  ToolUpdate,
} from '#/tool/toolContract';

import { textToolContent } from './tool-executor';
import type {
  ExecutableTool,
  ToolExecuteContext,
  ToolExecutionSnapshot,
  ToolPreparation,
  ToolPrepareContext,
  ToolReturn,
  ToolStoppingContext,
} from './types';

const LEGACY_ABORT_GRACE_MS = 2_000;

export interface LegacyToolFields {
  [key: string]: unknown;
  status?: string;
  statusReplace?: boolean;
  progress?: {
    text?: string;
    percent?: number;
    replace?: boolean;
  };
}

export type LegacyToolAgentContext = Omit<
  ExecutableToolContext,
  'toolCallId' | 'signal' | 'detach' | 'onUpdate'
> & {
  readonly step?: number;
};

export type LegacyToolPreparation =
  | {
      readonly kind: 'execute';
      readonly execution: RunnableToolExecution;
      readonly accesses?: ToolAccesses;
      readonly display?: ToolInputDisplay;
      readonly description?: string;
      readonly approvalRule: string;
      readonly matchesRule?: (ruleArgs: string) => boolean;
      startedAt?: number;
      durationMs?: number;
      cancellation?: {
        timer?: ReturnType<typeof setTimeout>;
      };
      result?: ExecutableToolResult;
      onExecuted?: () => void;
    }
  | {
      readonly kind: 'synthetic';
      result: ExecutableToolResult;
      readonly durationMs: 0;
    };

export interface LegacyResultFinalization<T extends ExecutableToolResult = ExecutableToolResult> {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: T;
}

export type LegacyResultFinalizer = <T extends ExecutableToolResult>(
  input: LegacyResultFinalization<T>,
) => T | Promise<T>;

export function legacyToolDurationMs(
  snapshot: ToolExecutionSnapshot<LegacyToolFields, LegacyToolPreparation>,
): number {
  return snapshot.prepared?.durationMs ?? 0;
}

export class LegacyExecutableToolAdapter<Input = unknown>
  implements ExecutableTool<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation> {
  constructor(
    readonly legacy: LegacyExecutableTool<Input>,
    private readonly finalizer?: LegacyResultFinalizer,
    private readonly now: () => number = Date.now,
  ) {}

  get name(): string {
    return this.legacy.name;
  }

  get description(): string {
    return this.legacy.description;
  }

  get parameters(): Record<string, unknown> {
    return this.legacy.parameters;
  }

  get deferred(): true | undefined {
    return this.legacy.deferred;
  }

  async prepare(
    context: ToolPrepareContext<Input, LegacyToolAgentContext>,
  ): Promise<ToolPreparation<LegacyToolPreparation>> {
    const execution = await this.legacy.resolveExecution(context.args);
    if (!('execute' in execution)) {
      const result = await this.finalize(
        context.call.id,
        coerceLegacyResult(execution, this.name),
      );
      return {
        type: 'synthetic',
        prepared: { kind: 'synthetic', result, durationMs: 0 },
        result: legacyResult(result, this.name),
      };
    }
    return {
      type: 'execute',
      prepared: {
        kind: 'execute',
        execution,
        accesses: execution.accesses,
        display: execution.display,
        description: execution.description,
        approvalRule: execution.approvalRule,
        matchesRule: execution.matchesRule,
        cancellation: {},
      },
    };
  }

  async execute(
    context: ToolExecuteContext<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation>,
  ): Promise<ToolReturn> {
    const prepared = context.prepared;
    if (prepared.kind === 'synthetic') return legacyResult(prepared.result, this.name);
    const execution = prepared.execution;
    const startedAt = this.now();
    prepared.startedAt = startedAt;
    const legacyContext: ExecutableToolContext = {
      ...context.context,
      toolCallId: context.call.id,
      signal: context.signal,
      detach: (text, brief) => {
        context.onDetach(() => ({ content: textToolContent(text), brief }));
        context.detach(text);
      },
      onDetach: (acknowledge) => context.onDetach(acknowledge),
      onUpdate: (update) => this.update(context, update),
      taskId: context.taskId,
      write: (text) => context.write(text),
      set: (fields) => context.set(fields),
    };
    try {
      let result: unknown;
      try {
        result = await execution.execute(legacyContext);
        prepared.durationMs ??= Math.max(0, this.now() - startedAt);
      } finally {
        prepared.durationMs ??= Math.max(0, this.now() - startedAt);
        const onExecuted = prepared.onExecuted;
        prepared.onExecuted = undefined;
        onExecuted?.();
      }
      const finalized = await this.finalize(context.call.id, coerceLegacyResult(result, this.name));
      prepared.result = finalized;
      return legacyResult(finalized, this.name);
    } finally {
      prepared.durationMs ??= Math.max(0, this.now() - startedAt);
      const cancellation = prepared.cancellation;
      if (cancellation?.timer !== undefined) {
        clearTimeout(cancellation.timer);
        cancellation.timer = undefined;
      }
    }
  }

  stopping(context: ToolStoppingContext<LegacyToolFields, LegacyToolPreparation>): void {
    const prepared = context.snapshot().prepared;
    if (prepared?.kind !== 'execute') {
      context.abandon();
      return;
    }
    prepared.execution.stopping?.({
      reason: context.reason,
      abandon: (result) => context.abandon(result === undefined ? undefined : legacyResult(result, this.name)),
    });
    const cancellation = prepared.cancellation ??= {};
    cancellation.timer = setTimeout(() => {
      cancellation.timer = undefined;
      if (prepared.startedAt !== undefined) {
        prepared.durationMs ??= Math.max(0, this.now() - prepared.startedAt);
      }
      context.abandon();
    }, LEGACY_ABORT_GRACE_MS);
  }

  private async finalize(
    toolCallId: string,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    const finalized = this.finalizer === undefined
      ? result
      : await this.finalizer({ toolName: this.name, toolCallId, result });
    return normalizeLegacyResult(finalized);
  }

  private update(
    context: ToolExecuteContext<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation>,
    update: ToolUpdate,
  ): void {
    if (update.fields !== undefined) context.set(update.fields);
    switch (update.kind) {
      case 'stdout':
      case 'stderr':
        context.write(update.text ?? '');
        return;
      case 'status':
        context.set({ status: update.text, statusReplace: update.replace });
        return;
      case 'progress':
        context.set({
          progress: { text: update.text, percent: update.percent, replace: update.replace },
        });
        return;
      case 'custom':
        return;
    }
  }
}

function coerceLegacyResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

function normalizeLegacyResult(result: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMedia = result.output.some((part) =>
      part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url'
    );
    if (hasMedia) {
      const hasText = result.output.some((part) => part.type === 'text' && part.text.length > 0);
      output = hasText ? result.output : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const text = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = text.length > 0 ? text : TOOL_OUTPUT_EMPTY;
    }
  }
  const normalized = { ...result, output };
  if (typeof normalized.note !== 'string') delete normalized.note;
  if (normalized.truncated !== true) delete normalized.truncated;
  return normalized;
}

function legacyResult(result: ExecutableToolResult, toolName: string): ToolReturn {
  const output: ContentPart[] = typeof result.output === 'string'
    ? textToolContent(result.output)
    : result.output;
  const content: ContentPart[] = typeof result.note === 'string'
    ? [...output, { type: 'text', text: result.note }]
    : output;
  if (result.isError === true) {
    return {
      content,
      outcome: 'failed',
      reason: contentText(content) || `Tool "${toolName}" returned an error.`,
    };
  }
  return { content, outcome: 'success' };
}

export { legacyResult as toLegacyToolReturn };

function contentText(content: readonly ContentPart[]): string {
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
