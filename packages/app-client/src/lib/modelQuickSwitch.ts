import type { AppModel } from '@moonshot-ai/app-core/api';

export const RECENT_MODELS_MENU_LIMIT = 5;

export interface ModelProviderGroup {
  provider: string;
  models: AppModel[];
}

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

export function groupUnstarredModelsByProvider(
  models: readonly AppModel[],
  starredIds: readonly string[],
): ModelProviderGroup[] {
  const starred = new Set(starredIds);
  const byProvider = new Map<string, AppModel[]>();
  for (const m of models) {
    let list = byProvider.get(m.provider);
    if (list === undefined) {
      list = [];
      byProvider.set(m.provider, list);
    }
    if (!starred.has(m.id)) list.push(m);
  }
  const groups: ModelProviderGroup[] = [];
  for (const [provider, list] of byProvider) {
    if (list.length > 0) groups.push({ provider, models: list });
  }
  return groups;
}
