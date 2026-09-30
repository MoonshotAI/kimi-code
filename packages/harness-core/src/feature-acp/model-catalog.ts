import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
  thinkingMetadataOf,
  type CatalogModelBinding,
} from '@moonshot-ai/agent-core';

export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
  readonly alwaysThinking?: boolean;
  readonly defaultThinkingEffort: string;
  readonly supportEfforts?: readonly string[];
}

export function projectModelCatalog(
  bindings: readonly CatalogModelBinding[],
): readonly AcpModelEntry[] {
  return bindings.map((binding) => {
    const supported = modelSupportsThinking(binding.model);
    const meta = thinkingMetadataOf(binding.model);
    return {
      id: binding.model.model,
      name: binding.model.displayName ?? binding.model.model,
      description: undefined,
      thinkingSupported: supported,
      alwaysThinking: meta?.alwaysThinking === true ? true : undefined,
      defaultThinkingEffort: supported ? defaultThinkingEffortForModel(binding.model) : 'on',
      supportEfforts: meta?.supportEfforts,
    };
  });
}

export function findModelBinding(
  bindings: readonly CatalogModelBinding[],
  modelId: string,
): CatalogModelBinding | undefined {
  return bindings.find((binding) => binding.model.model === modelId);
}
