import type { ModelCapability, ProviderConfig } from '@moonshot-ai/kosong';

export interface AgentConfigData {
  cwd: string;
  provider?: ProviderConfig;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingEffort: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingEffort: string;
  systemPrompt: string;
}>;
