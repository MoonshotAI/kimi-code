import type { ModelCapability, ThinkingEffort } from '#/app/llmProtocol';
import type { Model } from '#/app/model';

import { createDecorator } from "#/_base/di";
import type { ToolSource } from '#/agent/tool';

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

export interface SystemPromptContext {
  readonly cwd?: string;
  /** 2-level tree listing of the working directory, for LLM orientation. */
  readonly cwdListing?: string;
  /** Concatenated AGENTS.md instruction hierarchy (user-level + project-level). */
  readonly agentsMd?: string;
  /** Rendered listings of additional workspace directories. */
  readonly additionalDirsInfo?: string;
  /**
   * Present when the combined AGENTS.md content exceeds the recommended soft
   * budget. Surfaced through `getSessionWarnings` instead of truncating.
   */
  readonly agentsMdWarning?: string;
  readonly [key: string]: unknown;
}

export interface ResolvedAgentProfile {
  readonly name: string;
  readonly tools: readonly string[];
  systemPrompt(context: SystemPromptContext): string;
}

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

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;
  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  setModel(model: string): ProfileSetModelResult;
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
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  isToolActive(name: string, source?: ToolSource): boolean;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
