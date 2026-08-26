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

/**
 * Lowest accepted auto-compaction trigger ratio (fraction of the context
 * window at which auto-compaction triggers). Applies both to the global
 * `[loop_control] compaction_trigger_ratio` config value and to the
 * session-scoped override set through `setCompactionTriggerRatio`.
 */
export const COMPACTION_TRIGGER_RATIO_MIN = 0.25;

/** Highest accepted auto-compaction trigger ratio. */
export const COMPACTION_TRIGGER_RATIO_MAX = 0.99;

/** Validates a compaction trigger ratio; returns a human error message when invalid. */
export function compactionTriggerRatioError(
  ratio: number,
): string | undefined {
  if (!Number.isFinite(ratio) || ratio < COMPACTION_TRIGGER_RATIO_MIN || ratio > COMPACTION_TRIGGER_RATIO_MAX) {
    return `Invalid compaction trigger ratio "${String(ratio)}": must be between ${COMPACTION_TRIGGER_RATIO_MIN} and ${COMPACTION_TRIGGER_RATIO_MAX}.`;
  }
  return undefined;
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

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void;
  bind(input: BindAgentInput): Promise<void>;
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  /**
   * Set (or clear, when `ratio` is undefined) the session-scoped auto-compaction
   * trigger ratio override. Takes precedence over the global
   * `[loop_control] compaction_trigger_ratio` config value for the rest of the
   * session; it is never persisted. Throws `ProfileError` for values outside
   * [COMPACTION_TRIGGER_RATIO_MIN, COMPACTION_TRIGGER_RATIO_MAX].
   */
  setCompactionTriggerRatio(ratio: number | undefined): void;
  /** The session-scoped override set via {@link setCompactionTriggerRatio}, or undefined. */
  getCompactionTriggerRatioOverride(): number | undefined;
  /**
   * The effective auto-compaction trigger ratio — session override when set,
   * otherwise the global `[loop_control] compaction_trigger_ratio` config
   * value, otherwise undefined (the engine default applies). Unlike
   * {@link resolveModelContext} this never requires a bound model, so it is
   * safe to call on model-less sessions (e.g. from getStatus).
   */
  getEffectiveCompactionTriggerRatio(): number | undefined;
  republishStatus(): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveModelContextFor(modelAlias: string): ProfileModelContext;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
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