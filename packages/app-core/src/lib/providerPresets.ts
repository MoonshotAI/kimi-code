import { PROVIDER_ID_PATTERN } from './providerForm';

export interface ProviderPreset {
  key: string;
  catalogId: string;
  catalogIds?: readonly string[];
  providerId?: string;
  preferPresetName?: boolean;
  nameKey: string;
  descKey: string;
  icon: 'kimi' | 'zai' | 'zhipu' | 'deepseek' | 'minimax' | 'qwen';
  tagKey: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'kimi-for-coding',
    catalogId: 'kimi-for-coding',
    catalogIds: ['kimi-code-plan-cn', 'kimi-for-coding'],
    nameKey: 'providers.presets.kimiForCoding.name',
    descKey: 'providers.presets.kimiForCoding.desc',
    icon: 'kimi',
    tagKey: 'providers.tags.codingPlan',
  },
  {
    key: 'kimi-global',
    catalogId: 'kimi-code-plan-global',
    catalogIds: ['kimi-code-plan-global', 'kimi-for-coding-global'],
    nameKey: 'providers.presets.kimiForCodingGlobal.name',
    descKey: 'providers.presets.kimiForCodingGlobal.desc',
    icon: 'kimi',
    tagKey: 'providers.tags.codingPlan',
  },
  {
    key: 'zai-intl',
    catalogId: 'zai-coding-plan',
    nameKey: 'providers.presets.zaiIntl.name',
    descKey: 'providers.presets.zaiIntl.desc',
    icon: 'zai',
    tagKey: 'providers.tags.codingPlan',
  },
  {
    key: 'zai-cn',
    catalogId: 'zhipuai-coding-plan',
    nameKey: 'providers.presets.zaiCn.name',
    descKey: 'providers.presets.zaiCn.desc',
    icon: 'zhipu',
    tagKey: 'providers.tags.codingPlan',
  },
  {
    key: 'deepseek',
    catalogId: 'deepseek',
    nameKey: 'providers.presets.deepseek.name',
    descKey: 'providers.presets.deepseek.desc',
    icon: 'deepseek',
    tagKey: 'providers.tags.paygo',
  },
  {
    key: 'minimax-intl',
    catalogId: 'minimax-coding-plan',
    nameKey: 'providers.presets.minimaxIntl.name',
    descKey: 'providers.presets.minimaxIntl.desc',
    icon: 'minimax',
    tagKey: 'providers.tags.tokenPlan',
  },
  {
    key: 'minimax-cn',
    catalogId: 'minimax-cn-coding-plan',
    nameKey: 'providers.presets.minimaxCn.name',
    descKey: 'providers.presets.minimaxCn.desc',
    icon: 'minimax',
    tagKey: 'providers.tags.tokenPlan',
  },
  {
    key: 'alibaba-intl',
    catalogId: 'alibaba-coding-plan',
    providerId: 'alibaba-coding-plan',
    preferPresetName: true,
    nameKey: 'providers.presets.alibabaIntl.name',
    descKey: 'providers.presets.alibabaIntl.desc',
    icon: 'qwen',
    tagKey: 'providers.tags.codingPlan',
  },
  {
    key: 'alibaba-cn',
    catalogId: 'alibaba-coding-plan-cn',
    providerId: 'alibaba-coding-plan-cn',
    preferPresetName: true,
    nameKey: 'providers.presets.alibabaCn.name',
    descKey: 'providers.presets.alibabaCn.desc',
    icon: 'qwen',
    tagKey: 'providers.tags.codingPlan',
  },
];

export interface ProviderPresetMatch {
  preset: ProviderPreset;
}

const KIMI_CODING_ENDPOINTS: Readonly<Record<string, string>> = {
  'kimi-code-plan-cn': 'https://api.kimi.com/coding/v1',
  'kimi-code-plan-global': 'https://api.kimi.ai/coding/v1',
  'kimi-for-coding': 'https://api.kimi.com/coding/v1',
  'kimi-for-coding-global': 'https://api.kimi.ai/coding/v1',
};

export function kimiCodingProviderFor(catalogId: string): { type: 'kimi'; baseUrl: string } | null {
  const baseUrl = KIMI_CODING_ENDPOINTS[catalogId];
  return baseUrl === undefined ? null : { type: 'kimi', baseUrl };
}

export function catalogNameToProviderId(name: string, fallback: string): string {
  const cleaned = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\-_ ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return PROVIDER_ID_PATTERN.test(cleaned) ? cleaned : fallback;
}

export function presetProviderId(
  preset: ProviderPreset,
  entry?: { name: string },
): string {
  return preset.providerId ?? catalogNameToProviderId(entry?.name ?? '', preset.catalogId);
}

export function presetDisplayName(
  preset: ProviderPreset,
  entry: { name: string } | undefined,
  fallback: string,
): string {
  return preset.preferPresetName === true ? fallback : (entry?.name ?? fallback);
}

function presetCandidateIds(preset: ProviderPreset): readonly string[] {
  return [preset.catalogId, ...(preset.catalogIds ?? [])];
}

export function presetCatalogEntry<T extends { id: string }>(
  preset: ProviderPreset,
  entries: readonly T[],
): T | undefined {
  for (const id of preset.catalogIds ?? []) {
    const found = entries.find((e) => e.id === id);
    if (found !== undefined) return found;
  }
  return entries.find((e) => e.id === preset.catalogId);
}

export function presetCatalogId(
  preset: ProviderPreset,
  entries: readonly { id: string }[],
): string {
  return presetCatalogEntry(preset, entries)?.id ?? preset.catalogId;
}

export function matchProviderPreset(
  providerId: string,
  catalogEntries?: readonly { id: string; name: string }[],
): ProviderPresetMatch | null {
  const preset = PROVIDER_PRESETS.find((p) => {
    for (const id of presetCandidateIds(p)) {
      if (id === providerId) return true;
      const entry = catalogEntries?.find((e) => e.id === id);
      if (entry !== undefined && catalogNameToProviderId(entry.name, entry.id) === providerId) {
        return true;
      }
    }
    return false;
  });
  return preset === undefined ? null : { preset };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function matchProviderPresetByBaseUrl(
  baseUrl: string | undefined,
  catalogEntries: readonly { id: string; baseUrl: string | null }[],
): ProviderPresetMatch | null {
  if (baseUrl === undefined || baseUrl.trim() === '') return null;
  const host = hostOf(baseUrl.trim());
  if (host === null) return null;
  const preset = PROVIDER_PRESETS.find((p) => {
    for (const id of presetCandidateIds(p)) {
      const override = kimiCodingProviderFor(id);
      if (override !== null && hostOf(override.baseUrl) === host) return true;
      const entry = catalogEntries.find((e) => e.id === id);
      if (entry !== undefined && entry.baseUrl !== null && hostOf(entry.baseUrl) === host) {
        return true;
      }
    }
    return false;
  });
  return preset === undefined ? null : { preset };
}
