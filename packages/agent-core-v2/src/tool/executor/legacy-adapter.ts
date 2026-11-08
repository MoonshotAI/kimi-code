import type { ContentPart } from '#human/llm/message';
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
  ToolPreparation,
  ToolPrepareContext,
  ToolReturn,
} from './types';

export interface LegacyToolFields {
  status?: string;
  progress?: {
    text?: string;
    percent?: number;
  };
  custom?: {
    kind?: string;
    data?: unknown;
  };
}

export type LegacyToolAgentContext = Omit<
  ExecutableToolContext,
  'toolCallId' | 'signal' | 'detach' | 'onUpdate'
>;

export type LegacyToolPreparation =
  | {
      readonly kind: 'execute';
      readonly execution: RunnableToolExecution;
      readonly accesses?: ToolAccesses;
      readonly display?: ToolInputDisplay;
      readonly description?: string;
      readonly approvalRule: string;
      readonly matchesRule?: (ruleArgs: string) => boolean;
    }
  | {
      readonly kind: 'synthetic';
      readonly result: ExecutableToolResult;
    };

export interface LegacyResultFinalization<T extends ExecutableToolResult = ExecutableToolResult> {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: T;
}

export type LegacyResultFinalizer = <T extends ExecutableToolResult>(
  input: LegacyResultFinalization<T>,
) => T | Promise<T>;

export class LegacyExecutableToolAdapter<Input = unknown>
  implements ExecutableTool<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation> {
  constructor(
    readonly legacy: LegacyExecutableTool<Input>,
    private readonly finalizer?: LegacyResultFinalizer,
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
        prepared: { kind: 'synthetic', result },
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
      },
    };
  }

  async execute(
    context: ToolExecuteContext<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation>,
  ): Promise<ToolReturn> {
    const prepared = context.prepared;
    if (prepared.kind === 'synthetic') return legacyResult(prepared.result, this.name);
    const execution = prepared.execution;
    const legacyContext: ExecutableToolContext = {
      ...context.context,
      toolCallId: context.call.id,
      signal: context.signal,
      detach: (text) => {
        context.onDetach(() => ({ content: textToolContent(text) }));
        context.detach(text);
      },
      onUpdate: (update) => this.update(context, update),
    };
    const result = await execution.execute(legacyContext);
    return legacyResult(
      await this.finalize(context.call.id, coerceLegacyResult(result, this.name)),
      this.name,
    );
  }

  private async finalize(
    toolCallId: string,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    if (this.finalizer === undefined) return result;
    return this.finalizer({ toolName: this.name, toolCallId, result });
  }

  private update(
    context: ToolExecuteContext<Input, LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation>,
    update: ToolUpdate,
  ): void {
    switch (update.kind) {
      case 'stdout':
      case 'stderr':
        context.write(update.text ?? '');
        return;
      case 'status':
        context.set({ status: update.text });
        return;
      case 'progress':
        context.set({ progress: { text: update.text, percent: update.percent } });
        return;
      case 'custom':
        context.set({ custom: { kind: update.customKind, data: update.customData } });
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

function contentText(content: readonly ContentPart[]): string {
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
