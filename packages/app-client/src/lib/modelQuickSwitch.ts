import { MANAGED_KIMI_CODE_PROVIDER_ID, type AppModel } from '@moonshot-ai/app-core/api';

export const RECENT_MODELS_MENU_LIMIT = 5;
export const MOBILE_RECENT_MODELS_MENU_LIMIT = 3;

export function recentModelsForMenu(
  models: readonly AppModel[],
  recentIds: readonly string[],
  currentModelId: string | undefined,
): AppModel[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const result: AppModel[] = [];
  const orderedIds = currentModelId === undefined ? recentIds : [currentModelId, ...recentIds];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const model = byId.get(id);
    if (model === undefined) continue;
    result.push(model);
    if (result.length === RECENT_MODELS_MENU_LIMIT) break;
  }
  return result;
}

export function orderedModelProviders(models: readonly AppModel[]): string[] {
  const seen = new Set<string>();
  for (const model of models) seen.add(model.provider);
  const providers = Array.from(seen);
  return seen.has(MANAGED_KIMI_CODE_PROVIDER_ID)
    ? [MANAGED_KIMI_CODE_PROVIDER_ID, ...providers.filter((id) => id !== MANAGED_KIMI_CODE_PROVIDER_ID)]
    : providers;
}

export function providerModelsForMenu(
  models: readonly AppModel[],
  provider: string,
  currentModelId: string | undefined,
): AppModel[] {
  const catalogModels = models.filter((model) => model.provider === provider);
  const selected = catalogModels.find((model) => model.id === currentModelId);
  return selected === undefined
    ? catalogModels
    : [selected, ...catalogModels.filter((model) => model.id !== selected.id)];
}
