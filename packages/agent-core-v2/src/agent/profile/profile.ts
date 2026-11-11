import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type { ModelRequestParams } from '#/llm-adapter/model/generate';

import { createDecorator } from "#/_base/di/instantiation";
import type { ErrorCode } from '#/errors';
import { Error2 } from '#/_base/errors/errors';

import { ProfileErrors } from './errors';

export { ProfileErrors } from './errors';

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}

export interface AgentConfigData {
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export interface SystemPromptContext extends AgentProfileContext {
  readonly agentsMdWarning?: string;
  readonly agentsMdPaths?: readonly string[];
}

export type ResolvedAgentProfile = AgentProfile;

export interface ProfileData extends AgentConfigData {
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
}

export type ProfileUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  environmentDisclosure: EnvironmentDisclosureSnapshot;
  agentsMdPaths: readonly string[];
  disallowedTools: readonly string[];
  activeToolNames: readonly string[];
}>;

export interface ProfileBindingSnapshot {
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
}

export interface ProfileServiceOptions {
  readonly emitStatusUpdated?: () => void;
}

export interface ApplyProfileOptions {
  readonly additionalDirs?: readonly string[];
}

export interface ProfileModelContext {
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: ThinkingEffort;
  readonly reservedContextSize: number | undefined;
  readonly compactionTriggerRatio: number | undefined;
  readonly compactionMaxAttempts: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface BindAgentInput {
  readonly profile: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly strictThinking?: boolean;
}

export interface EffectiveProfileReader {
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
  getModelProviderType(alias?: string): string | undefined;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getModel(): string;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  getAgentsMdWarning(): string | undefined;
  republishStatus(): void;
}

export interface IAgentProfileService extends EffectiveProfileReader {
  readonly _serviceBrand: undefined;

  configure(options: ProfileServiceOptions): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): ProfileBindingSnapshot;
  defaultProfile(): ProfileBindingSnapshot;
  bind(input: BindAgentInput): Promise<ProfileBindingSnapshot>;
  resolveBinding(input: BindAgentInput, current?: ProfileBindingSnapshot): Promise<ProfileBindingSnapshot>;
  refreshBoundSubagentAllowlist(current?: ProfileBindingSnapshot): Promise<ProfileBindingSnapshot | undefined>;
  prepareUpdate(
    changed: ProfileUpdateData,
    current?: ProfileBindingSnapshot,
    activeTools?: readonly string[] | null,
  ): import('./profileOps').ProfileUpdatePlan;
  afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>, current?: ProfileBindingSnapshot): void;
  resolveModel(model: string): ProfileSetModelResult;
  resolveThinkingLevel(level: string, current?: ProfileBindingSnapshot): string;
  republishStatus(current?: ProfileBindingSnapshot): void;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): ProfileUpdateData;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<ProfileUpdateData>;
  getAgentsMdWarning(): string | undefined;
  data(snapshot?: ProfileBindingSnapshot): ProfileData;
  getEffectiveThinkingLevel(snapshot?: ProfileBindingSnapshot): ThinkingEffort;
  resolveModelContext(snapshot?: ProfileBindingSnapshot): ProfileModelContext;
  resolveRequestParams(snapshot?: ProfileBindingSnapshot): ModelRequestParams;
  getModelCapabilities(snapshot?: ProfileBindingSnapshot): ModelCapability;
  getModelProviderType(alias?: string, snapshot?: ProfileBindingSnapshot): string | undefined;
  getMaxOutputSize(snapshot?: ProfileBindingSnapshot): number | undefined;
  hasModel(snapshot?: ProfileBindingSnapshot): boolean;
  isRunnable(snapshot?: ProfileBindingSnapshot): boolean;
  hasProvider(snapshot?: ProfileBindingSnapshot): boolean;
  getModel(snapshot?: ProfileBindingSnapshot): string;
  getSystemPrompt(snapshot?: ProfileBindingSnapshot): string;
  getActiveToolNames(snapshot?: ProfileBindingSnapshot): readonly string[] | undefined;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
