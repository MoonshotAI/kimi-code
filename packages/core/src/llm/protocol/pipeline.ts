import type { Message, ToolDescription } from '#/llm/message';
import type {
  LlmModelSpec,
  LlmRequestModel,
  LlmSampling,
  ResponseFormat,
  ThinkingRequestOptions,
} from '#/llm/request';
import type { LlmNotice, LlmNoticeSink } from '#/llm/response';

import { applyPatterns, type Pattern } from './pattern';
import type { LlmModule } from './protocol';
import { legalize, type LegalizeSpec } from './rules';

export type PassTrace = (pass: string, output: unknown) => void;

export interface PassContext {
  readonly report: LlmNoticeSink;
}

export interface EncodeHooks {
  readonly trace?: PassTrace;
  readonly report?: (notice: LlmNotice) => void;
}

export interface PassRunner<TOptions> {
  readonly messages: (
    pass: string,
    module: LlmModule<TOptions>,
    rewrite: (messages: readonly Message[], ctx: PassContext) => readonly Message[],
  ) => LlmModule<TOptions>;
  readonly model: (
    pass: string,
    module: LlmModule<TOptions>,
    rewrite: (module: LlmModule<TOptions>, ctx: PassContext) => LlmRequestModel,
  ) => LlmModule<TOptions>;
}

export interface NativeModule<TMessage, TTool, TParams> {
  readonly system: string | undefined;
  readonly messages: readonly TMessage[];
  readonly tools: readonly TTool[];
  readonly params: TParams;
}

export interface PipelineSpec<TOptions, TMessage, TTool, TParams, TRequest> extends LegalizeSpec<TOptions> {
  readonly cacheKey?: (key: string) => Partial<TParams>;
  readonly thinking: (
    thinking: ThinkingRequestOptions | undefined,
    module: LlmModule<TOptions>,
  ) => Partial<TParams> | undefined;
  readonly responseFormat: (params: TParams, format: ResponseFormat) => TParams;
  readonly maxOutputTokens: (maxOutputTokens: number, model: LlmModelSpec) => Partial<TParams>;
  readonly sampling: (sampling: LlmSampling) => Partial<TParams>;
  readonly tool: (tool: ToolDescription) => TTool;
  readonly message: (message: Message, module: LlmModule<TOptions>) => readonly TMessage[];
  readonly mergeTurns?: readonly Pattern<TMessage>[];
  readonly annotate?: (
    native: NativeModule<TMessage, TTool, TParams>,
  ) => NativeModule<TMessage, TTool, TParams>;
  readonly finalize?: (
    native: NativeModule<TMessage, TTool, TParams>,
    module: LlmModule<TOptions>,
  ) => NativeModule<TMessage, TTool, TParams>;
  readonly flatten: (
    native: NativeModule<TMessage, TTool, TParams>,
    module: LlmModule<TOptions>,
  ) => TRequest;
}

function convert<TOptions, TMessage, TTool, TParams extends object>(
  module: LlmModule<TOptions>,
  pipeline: PipelineSpec<TOptions, TMessage, TTool, TParams, unknown>,
): NativeModule<TMessage, TTool, TParams> {
  const { model } = module;
  let params = {} as TParams;
  const apply = (patch: Partial<TParams> | undefined): void => {
    if (patch !== undefined) params = { ...params, ...patch };
  };
  if (model.cacheKey !== undefined && pipeline.cacheKey !== undefined) {
    apply(pipeline.cacheKey(model.cacheKey));
  }
  apply(pipeline.thinking(model.thinking, module));
  if (model.responseFormat !== undefined) {
    params = pipeline.responseFormat(params, model.responseFormat);
  }
  if (typeof model.maxOutputTokens === 'number') {
    apply(pipeline.maxOutputTokens(model.maxOutputTokens, model.spec));
  }
  if (model.sampling !== undefined) {
    apply(pipeline.sampling(model.sampling));
  }
  return {
    system: module.profile.systemPrompt,
    messages: module.content.messages.flatMap((message) => pipeline.message(message, module)),
    tools: (module.profile.tools ?? []).filter((tool) => tool.deferred !== true).map(pipeline.tool),
    params,
  };
}

function mergeTurns<TMessage, TTool, TParams>(
  native: NativeModule<TMessage, TTool, TParams>,
  patterns: readonly Pattern<TMessage>[] | undefined,
): NativeModule<TMessage, TTool, TParams> {
  if (patterns === undefined || patterns.length === 0) return native;
  return { ...native, messages: applyPatterns(native.messages, patterns) };
}

export function runPipeline<TOptions, TMessage, TTool, TParams extends object, TRequest>(
  pipeline: PipelineSpec<TOptions, TMessage, TTool, TParams, TRequest>,
  input: LlmModule<TOptions>,
  hooks?: EncodeHooks,
): TRequest {
  const run = <T>(pass: string, output: T): T => {
    hooks?.trace?.(pass, output);
    return output;
  };
  const contextOf = (pass: string): PassContext => ({
    report: (notice) => hooks?.report?.({ ...notice, source: pass }),
  });
  const passes: PassRunner<TOptions> = {
    messages: (pass, module, rewrite) => {
      const messages = rewrite(module.content.messages, contextOf(pass));
      return run(
        pass,
        messages === module.content.messages ? module : { ...module, content: { ...module.content, messages } },
      );
    },
    model: (pass, module, rewrite) => run(pass, { ...module, model: rewrite(module, contextOf(pass)) }),
  };

  const legal = legalize(input, pipeline, pipeline.cacheKey !== undefined, passes);
  const converted = run('convert', convert(legal, pipeline));
  const merged = run('merge-turns', mergeTurns(converted, pipeline.mergeTurns));
  const annotated = run('annotate-cache', pipeline.annotate?.(merged) ?? merged);
  const finalized = run('finalize-params', pipeline.finalize?.(annotated, legal) ?? annotated);
  return run('flatten', pipeline.flatten(finalized, legal));
}
