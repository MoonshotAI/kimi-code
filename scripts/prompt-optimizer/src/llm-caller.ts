/**
 * Prompt Optimizer — Real LLM API caller.
 *
 * Reads kimi-code's ~/.kimi-code/config.toml to get the API key and base URL,
 * then calls the OpenAI-compatible chat completion endpoint.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { LLMCaller, ModelResponse, RunnerConfig, ToolDefinition } from './benchmark/runner';

/**
 * Resolve the kimi-code config.toml path.
 */
function getConfigPath(): string {
  const envHome = process.env['KIMI_CODE_HOME'];
  const home = envHome ?? resolve(homedir(), '.kimi-code');
  return resolve(home, 'config.toml');
}

interface ProviderInfo {
  apiKey?: string;
  baseUrl?: string;
  type?: string;
}

/**
 * Extract provider configs from config.toml.
 * Returns a map of provider name → { apiKey, baseUrl, type }.
 */
function extractProvidersFromConfig(configPath: string): { providers: Record<string, ProviderInfo>; defaultModel?: string } {
  if (!existsSync(configPath)) return { providers: {} };
  const text = readFileSync(configPath, 'utf-8');

  let defaultModel: string | undefined;
  const defaultModelMatch = text.match(/^default_model\s*=\s*"([^"]+)"/m);
  if (defaultModelMatch) defaultModel = defaultModelMatch[1];

  const providers: Record<string, ProviderInfo> = {};
  // Match [providers."name"] or [providers.name] sections
  const providerRegex = /^\[providers\."?([^"\]]+)"?\]/gm;
  const lines = text.split('\n');

  let currentProvider: string | null = null;
  for (const line of lines) {
    const headerMatch = line.match(/^\[providers\."?([^"\]]+)"?\]/);
    if (headerMatch) {
      currentProvider = headerMatch[1]!;
      providers[currentProvider] = {};
      continue;
    }
    // Stop current provider on any new section header
    if (line.match(/^\[/) && !line.match(/^\[providers\./)) {
      currentProvider = null;
      continue;
    }
    if (!currentProvider || !providers[currentProvider]) continue;

    const kvMatch = line.match(/^(\w+)\s*=\s*"([^"]*)"/); 
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;
    if (key === 'api_key' && value) providers[currentProvider]!.apiKey = value;
    if (key === 'base_url' && value) providers[currentProvider]!.baseUrl = value;
    if (key === 'type' && value) providers[currentProvider]!.type = value;
  }

  return { providers, defaultModel };
}

/**
 * Resolve API credentials.
 * Priority: explicit RunnerConfig > env vars > config.toml (prefer 'newapi' provider).
 */
export function resolveCredentials(config: RunnerConfig): { apiKey: string; baseUrl: string; model: string; type: string } {
  const configPath = getConfigPath();
  const { providers, defaultModel } = extractProvidersFromConfig(configPath);

  // Prefer newapi provider, then deepseek, then first available
  const preferred = providers['newapi'] ?? providers['deepseek'] ?? Object.values(providers)[0];

  const apiKey = config.apiKey
    || process.env['KIMI_API_KEY']
    || process.env['KIMI_MODEL_API_KEY']
    || preferred?.apiKey
    || '';

  const baseUrl = config.apiBaseUrl
    || process.env['KIMI_BASE_URL']
    || process.env['KIMI_MODEL_BASE_URL']
    || preferred?.baseUrl
    || 'https://api.moonshot.ai/v1';

  const type = preferred?.type ?? 'openai';
  const model = config.model || defaultModel || 'deepseek-chat';

  return { apiKey, baseUrl, model, type };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Real LLM caller — reads config from ~/.kimi-code/config.toml.
 * Supports both OpenAI (/chat/completions) and Anthropic (/v1/messages) formats.
 */
export const realCaller: LLMCaller = async (
  systemPrompt: string,
  userMessages: string[],
  config: RunnerConfig,
  tools?: ToolDefinition[],
): Promise<ModelResponse> => {
  const { apiKey, baseUrl, model, type } = resolveCredentials(config);

  if (!apiKey) {
    throw new Error(
      'No API key found. Checked: RunnerConfig, KIMI_API_KEY env, KIMI_MODEL_API_KEY env, ~/.kimi-code/config.toml.\n' +
      `Config path: ${getConfigPath()}`
    );
  }

  if (type === 'anthropic') {
    return callAnthropic(systemPrompt, userMessages, apiKey, baseUrl, model, tools);
  }
  return callOpenAI(systemPrompt, userMessages, apiKey, baseUrl, model, tools);
};

async function callOpenAI(
  systemPrompt: string,
  userMessages: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
  tools?: ToolDefinition[],
): Promise<ModelResponse> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...userMessages.map((m) => ({ role: 'user' as const, content: m })),
  ];
  const body: Record<string, unknown> = { model, messages, temperature: 0.1, max_tokens: 2048 };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } }));
  }
  const start = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as ChatCompletionResponse;
  const choice = data.choices[0];
  if (!choice) throw new Error('No choices in API response');
  return {
    content: choice.message.content ?? '',
    toolCalls: (choice.message.tool_calls ?? []).map((tc) => ({ name: tc.function.name, input: tc.function.arguments })),
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    latencyMs,
  };
}

async function callAnthropic(
  systemPrompt: string,
  userMessages: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
  tools?: ToolDefinition[],
): Promise<ModelResponse> {
  const messages = userMessages.map((m) => ({ role: 'user' as const, content: m }));
  const body: Record<string, unknown> = { model, system: systemPrompt, messages, max_tokens: 2048, temperature: 0.1 };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters ?? { type: 'object', properties: {} } }));
  }
  const start = Date.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;
  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // Handle SSE streaming response
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    return parseAnthropicSSE(text, latencyMs);
  }

  // Handle normal JSON response
  const data = (await response.json()) as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
  const content = data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return {
    content,
    toolCalls: [],
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    latencyMs,
  };
}

/**
 * Parse Anthropic SSE stream and extract text content + tool_use blocks.
 */
function parseAnthropicSSE(raw: string, latencyMs: number): ModelResponse {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: { name: string; input: string }[] = [];
  let currentToolName = '';
  let currentToolInput = '';

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (json === '[DONE]') break;
    try {
      const event = JSON.parse(json);
      // Text content
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        content += event.delta.text ?? '';
      }
      // Tool use start
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        currentToolName = event.content_block.name ?? '';
        currentToolInput = '';
      }
      // Tool use input delta
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        currentToolInput += event.delta.partial_json ?? '';
      }
      // Tool use end
      if (event.type === 'content_block_stop' && currentToolName) {
        toolCalls.push({ name: currentToolName, input: currentToolInput });
        currentToolName = '';
        currentToolInput = '';
      }
      // Usage
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? 0;
      }
    } catch { /* skip non-JSON lines */ }
  }

  return {
    content,
    toolCalls,
    usage: { input: inputTokens, output: outputTokens },
    latencyMs,
  };
}
