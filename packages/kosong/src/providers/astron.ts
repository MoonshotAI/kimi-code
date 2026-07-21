import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OpenAILegacyChatProvider, type OpenAILegacyOptions } from './openai-legacy';

/** Models that support reasoning_effort intensity control alongside enable_thinking. */
const ASTRON_REASONING_EFFORT_MODEL_IDS: readonly string[] = [
  'xopglm52',           // GLM-5.2
  'xopdeepseekv4pro',   // DeepSeek-V4-Pro
  'xopdeepseekv4flash', // DeepSeek-V4-Flash
];

function loadAstronSettings(): {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  searchDisable?: boolean;
} | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.kimi-code', 'tui.toml'), 'utf-8');
    // Simple TOML parsing for the [astron] section — avoids pulling in smol-toml here.
    const match = raw.match(/\[astron\]([\s\S]*?)(?=\n\[|$)/);
    const section = match?.[1];
    if (!section) return undefined;
    const settings: Record<string, unknown> = {};
    for (const line of section.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (val === 'true') settings[key] = true;
      else if (val === 'false') settings[key] = false;
      else {
        const num = Number(val);
        settings[key] = Number.isFinite(num) ? num : val;
      }
    }
    if (Object.keys(settings).length === 0) return undefined;
    return {
      stream: settings['stream'] as boolean | undefined,
      temperature: settings['temperature'] as number | undefined,
      maxTokens: settings['max_tokens'] as number | undefined,
      searchDisable: settings['search_disable'] as boolean | undefined,
    };
  } catch {
    return undefined;
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
  constructor(config: OpenAILegacyOptions) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2',
      astronThinking: true,
      astronReasoningEffortModelIds: ASTRON_REASONING_EFFORT_MODEL_IDS,
      astronSettings: loadAstronSettings(),
    });
  }
}