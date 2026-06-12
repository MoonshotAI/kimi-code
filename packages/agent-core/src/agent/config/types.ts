import type { ModelCapability, ProviderConfig } from '@moonshot-ai/kosong';

export interface AgentConfigData {
  cwd: string;
  provider?: ProviderConfig;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
  generationKwargs?: Record<string, number>;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  generationKwargs: Record<string, number> | undefined;
}>;
