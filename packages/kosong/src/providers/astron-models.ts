/** Embedded model definitions for iFlytek Astron Coding Plan. */

export interface AstronModelDef {
  /** Model ID as used in API calls (e.g. "xopglm52"). */
  readonly id: string;
  /** Maximum context window size in tokens. */
  readonly contextLength: number;
}

/**
 * All 18 models available through Astron Coding Plan.
 *
 * All models support tool_use and thinking (via enable_thinking).
 * Three models additionally support reasoning_effort intensity control.
 */
export const ASTRON_MODEL_DEFS: readonly AstronModelDef[] = [
  { id: 'astron-code-latest', contextLength: 200_000 },
  { id: 'xsparkx2agent', contextLength: 256_000 },
  { id: 'xsparkx2', contextLength: 128_000 },
  { id: 'xsparkx2flash', contextLength: 256_000 },
  { id: 'auto', contextLength: 200_000 },
  { id: 'xopglm5', contextLength: 200_000 },
  { id: 'xopglm51', contextLength: 200_000 },
  { id: 'xopglm52', contextLength: 500_000 },
  { id: 'xopglmv47flash', contextLength: 128_000 },
  { id: 'xopdeepseekv4pro', contextLength: 1_000_000 },
  { id: 'xopdeepseekv4flash', contextLength: 1_000_000 },
  { id: 'xopdeepseekv32', contextLength: 128_000 },
  { id: 'xopkimik26', contextLength: 256_000 },
  { id: 'xopkimik25', contextLength: 128_000 },
  { id: 'xminimaxm25', contextLength: 128_000 },
  { id: 'xopqwen35397b', contextLength: 256_000 },
  { id: 'xopqwen36v35b', contextLength: 128_000 },
  { id: 'xopqwen35v35b', contextLength: 128_000 },
  { id: 'xop3qwencodernext', contextLength: 256_000 },
];

/** Provider key used for astron models in config (e.g. models["astron/xopglm52"]). */
export const ASTRON_PROVIDER_KEY = 'astron';