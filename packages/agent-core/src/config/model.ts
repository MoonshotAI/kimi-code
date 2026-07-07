import type { ModelAlias } from './schema';

export function effectiveModelAlias(alias: ModelAlias): ModelAlias {
  const { overrides, ...base } = alias;
  if (overrides === undefined) return alias;

  const effective: ModelAlias = {
    ...base,
    ...overrides,
  };

  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }

  return effective;
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}
