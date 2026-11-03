import type { PromptLaunch } from '#human/agent/turn';
import type { ContentPart } from '#human/llm/message';
import type { PromptFileAttachment } from '#/agent/contextMemory/types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly content?: readonly ContentPart[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: readonly ContentPart[];
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly skills: readonly PromptSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
  readonly steerIfActive?: boolean;
  readonly launch?: PromptLaunch;
}

export interface PromptWithSkillsResult {
  readonly turn_id?: number;
  readonly prompt_id: string;
  readonly created_at: string;
  readonly state: 'running' | 'queued' | 'blocked';
  readonly steered?: boolean;
}
