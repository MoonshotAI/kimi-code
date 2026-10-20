import {
  defaultThinkingEffortForModel,
  matchCatalogBinding,
  modelSupportsThinking,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';

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
      id: binding.alias,
      name: spec.displayName ?? spec.name,
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
  return matchCatalogBinding(modelId, bindings);
}
