import type {
  LlmModelSpec,
  ModelThinkingMetadata,
  ThinkingEffort,
} from '@moonshot-ai/agent-core/llm/request';

function effortsOf(meta: ModelThinkingMetadata | undefined): readonly string[] {
  return (
    meta?.supportEfforts
      ?.map((value) => value.trim())
      .filter((value): value is string => value.length > 0) ?? []
  );
}

export function modelSupportsThinking(spec: LlmModelSpec): boolean {
  const meta = spec.thinking;
  return (
    meta?.alwaysThinking === true ||
    meta?.adaptiveThinking === true ||
    spec.capability?.thinking === true
  );
}

export function defaultThinkingEffortForModel(spec: LlmModelSpec): ThinkingEffort {
  const meta = spec.thinking;
  if (!modelSupportsThinking(spec)) return 'off';
  const efforts = effortsOf(meta);
  if (efforts.length > 0) {
    const declared = meta?.defaultEffort?.trim();
    if (declared !== undefined && declared.length > 0 && efforts.includes(declared)) {
      return declared as ThinkingEffort;
    }
    return efforts[Math.floor(efforts.length / 2)] as ThinkingEffort;
  }
  return 'on';
}

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  spec: LlmModelSpec,
): ThinkingEffort {
  const meta = spec.thinking;
  const normalized = requested?.trim().toLowerCase();
  const effort: ThinkingEffort =
    normalized !== undefined && normalized.length > 0
      ? (normalized as ThinkingEffort)
      : defaultThinkingEffortForModel(spec);
  if (effort === 'off' && meta?.alwaysThinking === true) {
    return defaultThinkingEffortForModel(spec);
  }
  if (effort === 'on' && effortsOf(meta).length > 0) {
    return defaultThinkingEffortForModel(spec);
  }
  return effort;
}

export function invalidThinkingEffortMessage(
  spec: LlmModelSpec,
  effort: string,
): string | undefined {
  const meta = spec.thinking;
  if (effort === 'on') return undefined;
  if (effort === 'off') {
    if (meta?.offEffort !== undefined) return undefined;
    if (meta?.alwaysThinking === true) {
      const efforts = effortsOf(meta);
      return efforts.length > 0
        ? `Model '${spec.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${efforts.join(', ')}) instead of 'off'.`
        : `Model '${spec.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort instead of 'off'.`;
    }
    if (meta?.supportEfforts !== undefined) {
      return `Model '${spec.name}' reasons by default but declares no off effort, so thinking cannot be turned off. Declare offEffort (for example 'none') for this model in the model catalog configuration.`;
    }
    return undefined;
  }
  const efforts = effortsOf(meta);
  if (meta?.supportEfforts !== undefined && !efforts.includes(effort)) {
    return `Model '${spec.name}' does not support thinking effort '${effort}'. Supported efforts: ${efforts.join(', ')}. Set the thinking effort to one of the supported values.`;
  }
  if (meta === undefined && spec.capability?.thinking === false) {
    return `Model '${spec.name}' does not support thinking, but thinking effort '${effort}' was requested. Remove the thinking effort setting or choose a thinking-capable model.`;
  }
  return undefined;
}
