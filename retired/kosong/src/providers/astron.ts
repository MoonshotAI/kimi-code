import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OpenAILegacyChatProvider, type OpenAILegacyOptions } from './openai-legacy';

const ASTRON_DEFAULT_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2';

const ASTRON_REASONING_EFFORT_MODEL_IDS: readonly string[] = [
  'xopglm52',
  'xopdeepseekv4pro',
  'xopdeepseekv4flash',
];

interface AstronRuntimeSettings {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  searchDisable?: boolean;
}

function parseAstronTomlSection(text: string): AstronRuntimeSettings {
  const sectionMatch = text.match(/\[astron\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch?.[1]) return {};

  const section = sectionMatch[1];
  const result: AstronRuntimeSettings = {};

  const streamMatch = section.match(/^\s*stream\s*=\s*(true|false)/m);
  if (streamMatch) result.stream = streamMatch[1] === 'true';

  const tempMatch = section.match(/^\s*temperature\s*=\s*([\d.]+)/m);
  if (tempMatch?.[1]) result.temperature = parseFloat(tempMatch[1]);

  const maxTokensMatch = section.match(/^\s*max_tokens\s*=\s*(\d+)/m);
  if (maxTokensMatch?.[1]) result.maxTokens = parseInt(maxTokensMatch[1], 10);

  const searchMatch = section.match(/^\s*search_disable\s*=\s*(true|false)/m);
  if (searchMatch) result.searchDisable = searchMatch[1] === 'true';

  return result;
}

function loadAstronRuntimeSettings(): AstronRuntimeSettings {
  const configPath = join(homedir(), '.kimi-code', 'tui.toml');
  if (!existsSync(configPath)) return {};
  try {
    return parseAstronTomlSection(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Chat provider for iFlytek Astron Coding Plan.
 *
 * Reuses OpenAILegacyChatProvider with Coding Plan defaults:
 * - Base URL defaults to the Coding Plan endpoint
 * - Thinking parameters encoded via extra_body.enable_thinking + extra_body.reasoning_effort
 * - Runtime settings (stream, temperature, max_tokens, search) read from ~/.kimi-code/tui.toml
 */
export class AstronChatProvider extends OpenAILegacyChatProvider {
  constructor(options: OpenAILegacyOptions) {
    const runtime = loadAstronRuntimeSettings();

    super({
      ...options,
      baseUrl: options.baseUrl ?? ASTRON_DEFAULT_BASE_URL,
      stream: options.stream ?? runtime.stream ?? true,
      maxTokens: options.maxTokens ?? runtime.maxTokens ?? 32768,
      astronThinking: true,
      astronReasoningEffortModelIds: ASTRON_REASONING_EFFORT_MODEL_IDS,
      astronSettings: runtime.searchDisable !== undefined
        ? { searchDisable: runtime.searchDisable }
        : undefined,
    });
  }
}