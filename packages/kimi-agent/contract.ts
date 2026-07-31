/**
 * `@moonshot-ai/kimi-agent/contract` — public type-only entry.
 *
 * Aggregates the Rust engine wire contract (`src/contract.ts`) with the
 * shared runtime types that compat consumers (node-sdk `compatibility.ts`)
 * expect on this subpath. Types only — no runtime values beyond what
 * `src/contract.ts` itself defines (KimiError / ErrorCodes).
 */

export * from './src/contract';

// i18n — Locale lives in @moonshot-ai/kimi-i18n; re-exported here so
// consumers stay decoupled from the i18n package.
export type { Locale, TranslationKey } from './runtime/i18n-core';
