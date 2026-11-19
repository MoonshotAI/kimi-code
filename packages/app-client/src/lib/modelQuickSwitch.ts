import type { AppModel } from '@moonshot-ai/app-core/api';

export interface ModelProviderGroup {
  provider: string;
  models: AppModel[];
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
