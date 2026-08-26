import type { ContentPart } from '#/kosong/contract/message';
import type { PromptFileAttachment } from '#/agent/contextMemory/types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  readonly content?: readonly ContentPart[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: readonly ContentPart[];
  readonly skills: readonly PromptSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface PromptWithSkillsResult {
  readonly turn_id?: number;
  readonly prompt_id: string;
  readonly created_at: string;
  readonly state: 'running' | 'queued' | 'blocked';
}
