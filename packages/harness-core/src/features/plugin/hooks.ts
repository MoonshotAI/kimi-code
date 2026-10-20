import { HookDefSchema, type HookDefConfig } from '#/features/externalHooks/config-section';
import { HOOK_EVENT_TYPES, type HookDef, type HookEventType } from '#/features/externalHooks/internal/types';

export { HOOK_EVENT_TYPES, HookDefSchema, type HookDef, type HookDefConfig, type HookEventType };

export const PLUGIN_HOOK_SOURCE_ID = 'plugin';

export interface PluginHookSource {
  readonly id: string;
  load(): Promise<readonly HookDef[]>;
  onDidChange(listener: () => void): () => void;
}
