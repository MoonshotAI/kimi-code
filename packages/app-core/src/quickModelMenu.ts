import type { AppModel } from './api/types';

export interface QuickModelMenuProvider {
  id: string;
  label: string;
}

export interface QuickModelMenuPayload {
  models: AppModel[];
  recentModels: AppModel[];
  providerModels: AppModel[];
  providers: QuickModelMenuProvider[];
  activeProvider: string;
  activeProviderLabel: string;
  currentModelId?: string;
  currentEffort?: string;
  effortDescriptions?: Record<string, string>;
}

export type QuickModelMenuAction =
  | { type: 'select-model'; modelId: string; effort?: string }
  | { type: 'select-effort'; effort: string }
  | { type: 'select-provider'; providerId: string };
