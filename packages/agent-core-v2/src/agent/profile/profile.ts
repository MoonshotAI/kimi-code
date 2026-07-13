import type { AgentProfile, AgentProfileContext } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import type { Model } from '#/app/model/modelInstance';

import { createDecorator } from "#/_base/di/instantiation";
import type { ErrorCode } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import type { ToolSource } from '#/tool/toolContract';

import { ProfileErrors } from './errors';

export { ProfileErrors } from './errors';

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}

/**
 * Data required to configure an agent: active model id, its capability
 * matrix, profile, thinking level, system prompt, and working directory.
 * Owned by `profile` (which assembles it); consumed by `replayBuilder` and
 * `rpc` as a wire DTO. The runnable `Model` god-object is resolved on demand
 * via `resolveModel()`; it does not travel through this DTO.
 */
export interface AgentConfigData {
  cwd: string;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

/**
 * Runtime context supplied to a profile's system-prompt renderer. Extends the
 * catalog's {@link AgentProfileContext} (host OS/shell, cwd, AGENTS.md, skills,
 * …) with the AGENTS.md size warning produced by `prepareSystemPromptContext`.
 */
export interface SystemPromptContext extends AgentProfileContext {
  /**
   * Present when the combined AGENTS.md content exceeds the recommended soft
   * budget. Surfaced through `getSessionWarnings` instead of truncating.
   */
  readonly agentsMdWarning?: string;
}

/**
 * Resolved profile consumed by {@link IAgentProfileService.useProfile} /
 * {@link IAgentProfileService.applyProfile}. Alias of the catalog's
 * {@link AgentProfile} — a profile is self-contained (full system prompt +
 * tools), so the per-agent binding and the profile catalog share one type.
 */
export type ResolvedAgentProfile = AgentProfile;

export interface ProfileData extends AgentConfigData {
  readonly activeToolNames?: readonly string[];
}

export type ProfileUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  activeToolNames: readonly string[];
}>;

export interface ProfileServiceOptions {
  readonly cwd?: string | (() => string | undefined);
  readonly chdir?: (cwd: string) => void | Promise<void>;
  readonly emitStatusUpdated?: () => void;
}

export interface ApplyProfileOptions {
  /**
   * Additional workspace directories whose listings are appended to the system
   * prompt context. Defaults to the session workspace's additional dirs.
   */
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

/**
 * Atomic binding input: a named Profile plus a Model id/alias. Binding the two
 * (with optional run config) is what makes an Agent runnable — `Profile +
 * Model ⇒ Agent`. `profile` defaults to the catalog's default profile when the
 * caller only supplies a model (see {@link IAgentProfileService.setModel}).
 */
export interface BindAgentInput {
  /** Profile name from `IAgentProfileCatalogService` (e.g. 'agent', 'explore'). */
  readonly profile: string;
  /** Model id or routing alias resolved through `IModelResolver`. */
  readonly model: string;
  readonly thinking?: string;
  readonly cwd?: string;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  /**
   * Atomically bind a Profile + Model (plus optional run config) to this agent,
   * rendering the profile's system prompt and activating its tool set. This is
   * the production entry point that turns an agent scope into a runnable Agent.
   * Throws `PROFILE_NOT_FOUND` / `MODEL_NOT_CONFIGURED` on unknown inputs.
   */
  bind(input: BindAgentInput): Promise<void>;
  /**
   * Bind (or switch) the active Model. When no Profile is bound yet, the
   * catalog's default profile is bound first (rendering its system prompt and
   * tool set), so a fresh agent becomes runnable on its first `setModel`.
   * Subsequent calls swap the model while keeping the existing profile.
   */
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  /**
   * Production entry point for applying a profile: assembles the
   * {@link SystemPromptContext} (loading the AGENTS.md hierarchy, cwd listing,
   * and additional-dir listings), renders the profile's system prompt via
   * {@link useProfile}, and caches any AGENTS.md size warning for
   * {@link getAgentsMdWarning} / `getSessionWarnings`.
   */
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  /**
   * Re-render the active profile's system prompt from freshly gathered runtime
   * context without changing the active tool set.
   */
  refreshSystemPrompt(): Promise<void>;
  /**
   * The AGENTS.md size warning produced by the most recent {@link applyProfile},
   * if the combined AGENTS.md content exceeded the recommended soft budget.
   * `undefined` when no oversized content has been observed.
   */
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  resolveModelContext(): ProfileModelContext;
  /**
   * Return the runnable god-object `Model` for the currently-active model.
   * Throws when no model is configured — use {@link hasModel} to feature-test.
   */
  getProvider(): Model;
  /**
   * Return the runnable god-object `Model` for the currently-active model, or
   * `undefined` when no model is configured yet. Prefer this in code paths
   * that may run before configuration is ready.
   */
  resolveModel(): Model | undefined;
  /**
   * Alias of {@link getProvider}, exposed as a property so media/video tooling
   * (and tests) can read or override it directly.
   */
  readonly provider: Model;
  getModelCapabilities(): ModelCapability;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  /** True when both a Profile and a Model are bound — i.e. the agent can run a turn. */
  isRunnable(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  isToolActive(name: string, source?: ToolSource): boolean;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
