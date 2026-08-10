export const ASTRON_PROVIDER_KEY = 'astron';

/** Default OpenAI-compatible Coding Plan endpoint (xfyun MaaS `/v2`). */
export const ASTRON_DEFAULT_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2';

/**
 * Model ids that accept `reasoning_effort` (high/max) alongside
 * `enable_thinking`. Per the Coding Plan docs, only GLM-5.2 and the
 * DeepSeek-V4 Pro/Flash models support thinking-effort control.
 */
export const ASTRON_REASONING_EFFORT_MODEL_IDS: readonly string[] = [
  'xopglm52',
  'xopdeepseekv4pro',
  'xopdeepseekv4flash',
];

export interface AstronModelDef {
  readonly id: string;
  readonly contextLength: number;
  readonly displayName?: string;
}

export const ASTRON_MODEL_DEFS: readonly AstronModelDef[] = [
  { id: 'astron-code-latest', contextLength: 200_000, displayName: 'Astron Code (latest)' },
  { id: 'xsparkx2agent', contextLength: 256_000, displayName: 'Spark X2 Agent' },
  { id: 'xsparkx2', contextLength: 128_000, displayName: 'Spark X2' },
  { id: 'xsparkx2flash', contextLength: 256_000, displayName: 'Spark X2 Flash' },
  { id: 'auto', contextLength: 200_000, displayName: 'Auto (smart routing)' },
  { id: 'xopglm5', contextLength: 200_000, displayName: 'GLM-5' },
  { id: 'xopglm51', contextLength: 200_000, displayName: 'GLM-5.1' },
  { id: 'xopglm52', contextLength: 500_000, displayName: 'GLM-5.2' },
  { id: 'xopglmv47flash', contextLength: 128_000, displayName: 'GLM-4.7-Flash' },
  { id: 'xopdeepseekv4pro', contextLength: 1_000_000, displayName: 'DeepSeek-V4-Pro' },
  { id: 'xopdeepseekv4flash', contextLength: 1_000_000, displayName: 'DeepSeek-V4-Flash' },
  { id: 'xopdeepseekv32', contextLength: 128_000, displayName: 'DeepSeek-V3.2' },
  { id: 'xopkimik26', contextLength: 256_000, displayName: 'Kimi-K2.6' },
  { id: 'xopkimik25', contextLength: 128_000, displayName: 'Kimi-K2.5' },
  { id: 'xminimaxm25', contextLength: 128_000, displayName: 'MiniMax-M2.5' },
  { id: 'xopqwen35397b', contextLength: 256_000, displayName: 'Qwen3.5-397B-A17B' },
  { id: 'xopqwen36v35b', contextLength: 128_000, displayName: 'Qwen3.6-35B-A3B' },
  { id: 'xopqwen35v35b', contextLength: 128_000, displayName: 'Qwen3.5-35B-A3B' },
  { id: 'xop3qwencodernext', contextLength: 256_000, displayName: 'Qwen3-Coder-Next-FP8' },
];