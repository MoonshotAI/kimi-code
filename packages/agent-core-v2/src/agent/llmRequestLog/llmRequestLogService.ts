import {
  createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { Tool } from '#/app/llmProtocol';

import { ILogService } from "#/app/log/log";
import {
  IAgentLLMRequestLogService,
  type LLMRequestLogInput,
} from './llmRequestLog';

export class AgentLLMRequestLogService implements IAgentLLMRequestLogService {
  readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  logRequest(input: LLMRequestLogInput): void {
    const requestLogFields = input.fields ?? {};
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
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
      this.log.info('llm config', { ...requestLogFields, ...config });
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
    this.log.info('llm request', requestFields);
  }
}

function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequestLogService,
  AgentLLMRequestLogService,
  InstantiationType.Delayed,
  'llmRequestLog',
);
