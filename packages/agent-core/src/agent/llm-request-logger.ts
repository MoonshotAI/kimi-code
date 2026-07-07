import { createHash } from 'node:crypto';

import type { Logger } from '#/logging/types';
import type { ChatProvider, GenerateOptions, Message, Tool } from '@moonshot-ai/kosong';

import type { LLMRequestLogFields } from '../loop';

export type GenerateOptionsWithRequestLogFields = GenerateOptions & {
  readonly requestLogFields?: LLMRequestLogFields;
};

export class LlmRequestLogger {
  private lastConfigLogSignature: string | undefined;

  constructor(private readonly log: Logger) {}

  logRequest(input: {
    readonly provider: ChatProvider;
    readonly modelAlias?: string;
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly messages: readonly Message[];
    readonly fields: LLMRequestLogFields | undefined;
  }): void {
    const { provider, modelAlias, systemPrompt, tools, messages, fields } = input;
    const requestLogFields = fields ?? {};
    // This logs the outbound request; deferred tools are stripped by kosong
    // generate() before the provider sees them, so mirror that here or the
    // toolCount/toolsHash would describe a request that never hits the wire.
    const wireTools = tools.filter((tool) => tool.deferred !== true);
    const config = {
      provider: provider.name,
      model: provider.modelName,
      modelAlias,
      thinkingEffort: provider.thinkingEffort ?? undefined,
      systemPromptChars: systemPrompt.length,
      toolCount: wireTools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(wireTools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...requestLogFields, ...config });
    }

    const partialMessageCount = messages.filter((message) => message.partial === true).length;
    const requestFields: {
      turnStep?: string;
      attempt?: string;
      partialMessageCount?: number;
    } = { ...requestLogFields };
    if (partialMessageCount > 0) requestFields.partialMessageCount = partialMessageCount;
    this.log.info('llm request', requestFields);
  }
}

export function splitGenerateOptions(options: GenerateOptionsWithRequestLogFields | undefined): {
  readonly requestLogFields: LLMRequestLogFields | undefined;
  readonly generateOptions: GenerateOptions | undefined;
} {
  if (options === undefined) {
    return { requestLogFields: undefined, generateOptions: undefined };
  }
  const { requestLogFields, ...generateOptions } = options;
  return { requestLogFields, generateOptions };
}

export function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
