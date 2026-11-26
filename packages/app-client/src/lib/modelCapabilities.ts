import type { AppModel } from '@moonshot-ai/app-core/api';
import { formatTokens } from '@moonshot-ai/app-core/lib';

export type ModelCapabilityItem =
  | { kind: 'context'; size: string }
  | { kind: 'image' }
  | { kind: 'tool' }
  | { kind: 'thinking' }
  | { kind: 'always-thinking' };

export function modelCapabilityItems(model: AppModel): ModelCapabilityItem[] {
  const items: ModelCapabilityItem[] = [];
  if (model.maxContextSize > 0) {
    items.push({ kind: 'context', size: formatTokens(model.maxContextSize).toUpperCase() });
  }
  const capabilities = model.capabilities ?? [];
  if (capabilities.includes('image_in')) items.push({ kind: 'image' });
  if (capabilities.includes('tool_use')) items.push({ kind: 'tool' });
  if (capabilities.includes('always_thinking')) items.push({ kind: 'always-thinking' });
  else if (capabilities.includes('thinking')) items.push({ kind: 'thinking' });
  return items;
}
