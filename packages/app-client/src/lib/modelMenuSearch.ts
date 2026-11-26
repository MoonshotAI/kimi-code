import type { AppModel } from '@moonshot-ai/app-core/api';

export interface ModelSearchTextRange {
  start: number;
  end: number;
}

export interface ModelSearchResult {
  model: AppModel;
  modelName: string;
  providerName: string;
  modelRanges: ModelSearchTextRange[];
  providerRanges: ModelSearchTextRange[];
  matchedProvider: boolean;
}

function findRanges(text: string, query: string): ModelSearchTextRange[] {
  if (query.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: ModelSearchTextRange[] = [];
  let from = 0;
  while (from < lower.length) {
    const index = lower.indexOf(query, from);
    if (index === -1) break;
    ranges.push({ start: index, end: index + query.length });
    from = index + query.length;
  }
  return ranges;
}

export function searchModelsForMenu(
  models: readonly AppModel[],
  query: string,
  providerLabel: (provider: string) => string,
): ModelSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const results: ModelSearchResult[] = [];
  for (const model of models) {
    const modelName = model.displayName ?? model.model;
    const providerName = providerLabel(model.provider);
    const modelRanges = findRanges(modelName, normalized);
    const providerRanges = findRanges(providerName, normalized);
    const matchesRawId =
      modelRanges.length === 0 && providerRanges.length === 0 && model.id.toLowerCase().includes(normalized);
    if (modelRanges.length === 0 && providerRanges.length === 0 && !matchesRawId) continue;
    results.push({
      model,
      modelName,
      providerName,
      modelRanges,
      providerRanges,
      matchedProvider: providerRanges.length > 0,
    });
  }
  return results;
}
