import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

import { createDecorator } from "#/_base/di/instantiation";
import type { ErrorCode } from '#/errors';
import { Error2 } from '#/_base/errors/errors';
import type { Hooks } from '#/hooks';

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

export interface WillSetModelContext {
  readonly currentAlias: string | undefined;
  readonly nextAlias: string;
  readonly nextMaxContextTokens: number | undefined;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<{
    /**
     * Runs inside `setModel` after the target model resolved but before the
     * alias (and thus the provider used for new requests) switches. Handlers
     * that need the CURRENT model still active — e.g. pre-compacting an
     * oversized context with the larger-window model — must finish before
     * calling `next`.
     */
    onWillSetModel: WillSetModelContext;
  }>;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void;
  bind(input: BindAgentInput): Promise<void>;
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  republishStatus(): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  refreshSystemPrompt(): Promise<void>;
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
  /**
   * Effective context window of the active model (`max_input_tokens` when the
   * capability declares one, else `max_context_tokens`), clamped by the
   * context ceiling learned from provider overflow rejections (see
   * {@link observeMaxContextTokens}). The configured capability wins until an
   * overflow proves the real window smaller; consumers that size budgets or
   * triggers against the window must read this, not the raw capability.
   */
  getEffectiveMaxContextTokens(): number;
  /**
   * Record a context-window ceiling learned from a provider overflow rejection
   * for the active model alias. Ignored when the value is not below the
   * current effective max, so a stale or misattributed observation can never
   * loosen the clamp.
   */
  observeMaxContextTokens(observed: number): void;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
