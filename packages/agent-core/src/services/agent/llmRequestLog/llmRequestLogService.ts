import { createHash } from 'node:crypto';

import type { Tool } from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from '../../../di';
import { ILogService } from '../../logger/logger';
import {
  ILLMRequestLogService,
  type LLMRequestLogInput,
} from './llmRequestLog';

export class LLMRequestLogService implements ILLMRequestLogService {
  readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  logRequest(input: LLMRequestLogInput): void {
    const requestLogFields = input.fields ?? {};
    const config = {
      provider: input.provider.name,
      model: input.provider.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.provider.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: input.tools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(input.tools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info({ ...requestLogFields, ...config }, 'llm config');
    }

    const partialMessageCount = input.messages.filter(
      (message) => message.partial === true,
    ).length;
    const requestFields: {
      turnStep?: string;
      attempt?: string;
      partialMessageCount?: number;
    } = { ...requestLogFields };
    if (partialMessageCount > 0) requestFields.partialMessageCount = partialMessageCount;
    this.log.info(requestFields, 'llm request');
  }
}

function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

registerSingleton(
  ILLMRequestLogService,
  new SyncDescriptor(LLMRequestLogService, [], true),
);
