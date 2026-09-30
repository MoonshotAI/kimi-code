import type { ModelCapability } from '#/llm/request';
import { mergeFields } from '#/llm/requester';

import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderSnapshot,
} from './types';

export const UNKNOWN_CAPABILITY: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  dynamically_loaded_tools: false,
};

function normalizeCapability(capability: ModelCapability | undefined): ModelCapability {
  if (capability === undefined) return UNKNOWN_CAPABILITY;
  return {
    image_in: capability.image_in === true,
    video_in: capability.video_in === true,
    audio_in: capability.audio_in === true,
    thinking: capability.thinking === true,
    tool_use: capability.tool_use ?? true,
    dynamically_loaded_tools: capability.dynamically_loaded_tools === true,
  };
}

function clampMaxInputSize(
  maxContextSize: number | undefined,
  maxInputSize: number | undefined,
): number | undefined {
  if (
    maxInputSize !== undefined &&
    maxContextSize !== undefined &&
    maxInputSize > maxContextSize
  ) {
    return maxContextSize;
  }
  return maxInputSize;
}

export function mergeCatalogModel(
  providerId: string,
  discovered: CatalogModelDefinition | undefined,
  override: CatalogModelDefinition | undefined,
  pingError?: string,
): CatalogModel | undefined {
  if (discovered === undefined && override === undefined) return undefined;
  const combined = mergeFields(
    discovered as Readonly<Record<string, unknown>> | undefined,
    override as Readonly<Record<string, unknown>> | undefined,
  ) as unknown as CatalogModelDefinition;

  const id = override?.id ?? discovered!.id;
  const provider = combined.provider ?? providerId;
  const name = combined.name ?? id;
  const maxContextSize = combined.maxContextSize;
  const maxInputSize = clampMaxInputSize(maxContextSize, combined.maxInputSize);
  const capability = normalizeCapability(combined.capability);

  let thinking = combined.thinking;
  if (
    thinking !== undefined &&
    override?.thinking?.supportEfforts !== undefined &&
    override.thinking.defaultEffort === undefined &&
    thinking.defaultEffort !== undefined &&
    !override.thinking.supportEfforts.includes(thinking.defaultEffort)
  ) {
    const { defaultEffort: _dropped, ...rest } = thinking;
    thinking = rest;
  }

  return {
    ...combined,
    id,
    provider,
    name,
    maxContextSize,
    maxInputSize,
    capability,
    thinking,
    pingError,
  };
}

function findDiscoveredForOverride(
  entry: CatalogProviderSnapshot,
  modelId: string,
  override: CatalogModelDefinition | undefined,
): CatalogModelDefinition | undefined {
  const direct = entry.discovered[modelId];
  if (direct !== undefined) return direct;
  if (override?.name !== undefined) return entry.discovered[override.name];
  return undefined;
}

export function resolveSnapshotModel(
  providerId: string,
  entry: CatalogProviderSnapshot | undefined,
  modelId: string,
): CatalogModel | undefined {
  if (entry === undefined) return undefined;
  const override = entry.override[modelId];
  const discovered = findDiscoveredForOverride(entry, modelId, override);
  return mergeCatalogModel(providerId, discovered, override, entry.pingErrors?.[modelId]);
}

export function listSnapshotModels(
  providerId: string,
  entry: CatalogProviderSnapshot | undefined,
): CatalogModel[] {
  if (entry === undefined) return [];
  const ids = new Set<string>([
    ...Object.keys(entry.override),
    ...Object.keys(entry.discovered),
  ]);
  const models: CatalogModel[] = [];
  for (const id of ids) {
    const merged = resolveSnapshotModel(providerId, entry, id);
    if (merged !== undefined) models.push(merged);
  }
  return models.toSorted((a, b) => a.id.localeCompare(b.id));
}
