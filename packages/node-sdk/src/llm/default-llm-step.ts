/**
 * Default host-proxy LLM step for the Rust engine.
 *
 * Engine turns run in host-proxy mode: the engine hands each model request to
 * an `llmStep` callback owned by the host. `createKimiHarness` requires one —
 * when the host does not supply it, this module builds a provider-backed
 * implementation from the SDK's own config.toml:
 *
 * - `model_name` is resolved through the `models` table (alias → provider +
 *   real model name);
 * - each engine request is proxied as an OpenAI-compatible chat-completions
 *   stream over plain `fetch` (Node 24);
 * - the `user-agent` header carries the host identity so third-party
 *   endpoints observe the embedding product (e.g. `kimi-code-vscode/1.2.3`).
 *
 * Anthropic-protocol providers (`models.<alias>.protocol === 'anthropic'`)
 * are not supported by this bridge and fail with a clear error.
 */

import type { LlmChatRequest } from '@moonshot-ai/kimi-agent/rust-loop';

import { readConfigFile } from '#/legacy/config';
import type { KimiHostIdentity } from '#/types';

export interface DefaultLlmStepOptions {
  readonly configPath: string;
  readonly identity?: KimiHostIdentity | undefined;
}

const CHAT_COMPLETIONS_PATH = '/chat/completions';
const LLM_STEP_TIMEOUT_MS = 120_000;

interface ResolvedProvider {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly customHeaders: Record<string, string> | undefined;
}

function defaultUserAgent(identity: KimiHostIdentity | undefined): string {
  if (identity === undefined) return 'kimi-code-sdk';
  return `${identity.userAgentProduct}/${identity.version}`;
}

function resolveProvider(
  configPath: string,
  modelName: string,
): ResolvedProvider {
  const config = readConfigFile(configPath);
  const modelAlias = config.models?.[modelName];

  let providerId: string | undefined;
  let model = modelName;
  if (modelAlias !== undefined) {
    if (modelAlias.protocol === 'anthropic') {
      throw new Error(
        `Model "${modelName}" uses the Anthropic protocol, which the SDK's default LLM bridge does not support. ` +
          `Configure a provider-compatible llmStep, or use an OpenAI-compatible model.`,
      );
    }
    providerId = modelAlias.provider;
    model = modelAlias.model;
  } else {
    // No alias: treat `model_name` as both the provider id and the real
    // model name, matching the config convention where a provider section
    // may double as an implicit model source.
    providerId = config.providers[modelName] !== undefined ? modelName : undefined;
  }

  const provider = providerId === undefined ? undefined : config.providers[providerId];
  if (provider === undefined) {
    throw new Error(
      `No provider found for model "${modelName}" (config: ${configPath}). ` +
        `Define a [models."${modelName}"] entry pointing at a configured provider.`,
    );
  }
  if (provider.type === 'anthropic') {
    throw new Error(
      `Provider "${providerId}" uses the Anthropic protocol, which the SDK's default LLM bridge does not support.`,
    );
  }

  const baseUrl = modelAlias?.baseUrl ?? provider.baseUrl;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(
      `Provider "${providerId}" has no base_url (config: ${configPath}); the SDK's default LLM bridge needs an OpenAI-compatible endpoint.`,
    );
  }

  return {
    model,
    baseUrl,
    apiKey: provider.apiKey,
    customHeaders: provider.customHeaders,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}${path}`;
}

interface StreamedToolCallDelta {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * Parse an OpenAI-compatible chat-completions SSE stream, accumulating text,
 * tool calls, finish reason and usage.
 */
async function collectChatCompletions(
  response: globalThis.Response,
): Promise<{ content: string; toolCalls: Map<number, StreamedToolCallDelta>; finishReason?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
  if (response.body === null) {
    throw new Error('LLM provider returned an empty response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map<number, StreamedToolCallDelta>();
  let finishReason: string | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  const processLine = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = (chunk as { choices?: Array<Record<string, unknown>> }).choices?.[0];
    if (choice === undefined) return;

    const delta = (choice['delta'] ?? {}) as {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    if (typeof delta.content === 'string') {
      content += delta.content;
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const acc = toolCalls.get(index) ?? { arguments: '' };
      if (tc.id !== undefined) acc.id = tc.id;
      if (tc.function?.name !== undefined) acc.name = tc.function.name;
      if (tc.function?.arguments !== undefined) acc.arguments += tc.function.arguments;
      toolCalls.set(index, acc);
    }
    if (typeof choice['finish_reason'] === 'string' && choice['finish_reason'] !== null) {
      finishReason = choice['finish_reason'];
    }
    const chunkUsage = choice['usage'] as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;
    if (chunkUsage !== undefined) usage = chunkUsage;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) processLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  // Flush any trailing data (SSE frames without a final newline).
  if (buffer.trim().length > 0) {
    for (const line of buffer.split('\n')) {
      if (line.trim().length > 0) processLine(line.trimEnd());
    }
  }

  return { content, toolCalls, finishReason, usage };
}

export function createDefaultLlmStep(
  options: DefaultLlmStepOptions,
): (req: unknown) => Promise<unknown> {
  const userAgent = defaultUserAgent(options.identity);

  return async (req: unknown): Promise<unknown> => {
    const request = req as LlmChatRequest;
    const provider = resolveProvider(options.configPath, request.model_name);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': userAgent,
    };
    if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${provider.apiKey}`;
    }
    for (const [name, value] of Object.entries(provider.customHeaders ?? {})) {
      headers[name.toLowerCase()] = value;
    }

    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [
        { role: 'system', content: request.system_prompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      stream: true,
    };
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }));
    }

    let response: globalThis.Response;
    try {
      console.log('PROBE LLMSTEP: fetch start', joinUrl(provider.baseUrl, CHAT_COMPLETIONS_PATH));
      response = await fetch(joinUrl(provider.baseUrl, CHAT_COMPLETIONS_PATH), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_STEP_TIMEOUT_MS),
      });
      console.log('PROBE LLMSTEP: fetch resolved', response.status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`LLM provider request failed: ${detail}`, { cause: error });
    }

    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        detail = parsed.error?.message ?? text;
      } catch {
        detail = await response.text().catch(() => '');
      }
      throw new Error(
        `LLM provider returned ${response.status}: ${detail || response.statusText}`,
      );
    }

    const { content, toolCalls, finishReason, usage } = await collectChatCompletions(response);
    console.log('PROBE LLMSTEP: parsed', JSON.stringify({ content, finishReason, toolCalls: [...toolCalls.keys()], usage }));

    const tool_calls = [...toolCalls.values()].map((tc) => ({
      id: tc.id ?? '',
      name: tc.name ?? '',
      arguments: tc.arguments,
    }));

    return {
      ...(content.length > 0 ? { content } : {}),
      tool_calls,
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      usage: {
        ...(usage?.prompt_tokens !== undefined ? { input_tokens: usage.prompt_tokens } : {}),
        ...(usage?.completion_tokens !== undefined
          ? { output_tokens: usage.completion_tokens }
          : {}),
        ...(usage?.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
      },
    };
  };
}
