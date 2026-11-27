import type { AppModel } from '@moonshot-ai/app-core/api';
import { modelThinkingAvailability, segmentsFor } from '@moonshot-ai/app-core/lib';
import type { ModelSearchTextRange, modelCapabilityItems } from '@moonshot-ai/app-client/lib';

type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface SearchHighlightPart {
  text: string;
  matched: boolean;
}

export interface QuickModelMenuEmits {
  selectModel: [modelId: string, effort?: string, fromSearch?: boolean];
  selectEffort: [effort: string];
  selectProvider: [providerId: string];
  dismiss: [];
}

export function supportsThinkingSubmenu(model: AppModel): boolean {
  return modelThinkingAvailability(model) !== 'unsupported' && segmentsFor(model).length > 0;
}

export function highlightSearchText(text: string, ranges: readonly ModelSearchTextRange[]): SearchHighlightPart[] {
  if (ranges.length === 0) return [{ text, matched: false }];
  const parts: SearchHighlightPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), matched: false });
    parts.push({ text: text.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false });
  return parts;
}

export function modelCapabilityText(item: ReturnType<typeof modelCapabilityItems>[number], t: Translate): string {
  switch (item.kind) {
    case 'context':
      return t('model.capabilityContext', { size: item.size });
    case 'image':
      return t('model.capabilityImageInput');
    case 'tool':
      return t('model.capabilityToolUse');
    case 'thinking':
      return t('model.capabilityThinking');
    case 'always-thinking':
      return t('model.capabilityAlwaysThinking');
  }
}
