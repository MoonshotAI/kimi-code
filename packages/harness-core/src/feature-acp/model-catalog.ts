import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
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
    const spec = binding.model;
    const supported = modelSupportsThinking(spec);
    return {
      id: binding.model.name,
      name: binding.model.displayName ?? binding.model.name,
      description: undefined,
      thinkingSupported: supported,
      alwaysThinking: spec.thinking?.alwaysThinking === true ? true : undefined,
      defaultThinkingEffort: supported ? defaultThinkingEffortForModel(spec) : 'on',
      supportEfforts: spec.thinking?.supportEfforts,
    };
  });
}

export function findModelBinding(
  bindings: readonly CatalogModelBinding[],
  modelId: string,
): CatalogModelBinding | undefined {
  return bindings.find(
    (binding) => binding.model.name === modelId || binding.model.id === modelId,
  );
}
