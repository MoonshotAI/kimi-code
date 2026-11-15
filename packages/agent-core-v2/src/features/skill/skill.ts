import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type { PromptFileAttachment } from '#/agent/contextMemory/types';
import type { LoopSubmitOptions } from '#/agent/loop/loop';

export interface SkillActivationInput {
  readonly name: string;
  readonly path?: string;
  readonly args?: string;
  readonly promptId?: string;
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly content?: readonly ContentPart[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly path?: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: readonly ContentPart[];
  readonly promptId?: string;
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly skills: readonly PromptSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
  readonly steerIfActive?: boolean;
  readonly delivery?: LoopSubmitOptions['delivery'];
  readonly onStart?: LoopSubmitOptions['onStart'];
}

export interface PromptWithSkillsResult {
  readonly turn_id?: number;
  readonly prompt_id: string;
  readonly created_at: string;
  readonly state: 'running' | 'queued' | 'blocked';
  readonly steered?: boolean;
}
