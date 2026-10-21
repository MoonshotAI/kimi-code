import type { ModelCatalogItem } from '@moonshot-ai/klient';

export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
  readonly alwaysThinking?: boolean;
  readonly defaultThinkingEffort: string;
  readonly supportEfforts?: readonly string[];
}

const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

export function deriveThinkingSupported(item: ModelCatalogItem): boolean {
  const capabilities = item.capabilities ?? [];
  if (capabilities.includes('thinking') || capabilities.includes('always_thinking')) return true;
  const lower = item.model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  if (TOGGLEABLE_THINKING_MODELS.has(item.model)) return true;
  return false;
}

export function deriveAlwaysThinking(item: ModelCatalogItem): boolean {
  return (item.capabilities ?? []).includes('always_thinking');
}

export function deriveDefaultThinkingEffort(item: ModelCatalogItem): string {
  const efforts = item.support_efforts;
  if (efforts !== undefined && efforts.length > 0) {
    return item.default_effort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

export function projectModelCatalog(
  items: readonly ModelCatalogItem[],
): readonly AcpModelEntry[] {
  return items.map((item) => ({
    id: item.model,
    name: item.display_name ?? item.model,
    thinkingSupported: deriveThinkingSupported(item),
    alwaysThinking: deriveAlwaysThinking(item),
    defaultThinkingEffort: deriveDefaultThinkingEffort(item),
    supportEfforts:
      item.support_efforts !== undefined && item.support_efforts.length > 0
        ? item.support_efforts
        : undefined,
  }));
}
