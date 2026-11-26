import { z } from 'zod';

import type { ProtocolName } from '@moonshot-ai/core/llm/protocol/protocol';

export const ProtocolSchema = z.enum(['anthropic', 'openai', 'openai_responses', 'google-genai']);

export type Protocol = ProtocolName;

export interface ProtocolProviderOptions {
  readonly reasoningKey?: string;
  readonly defaultMaxTokens?: number;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly betaApi?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly vertexai?: boolean;
  readonly project?: string;
  readonly location?: string;
}

export interface ProtocolAdapterConfig {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly modelName: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

