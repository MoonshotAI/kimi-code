/**
 * Shared i18n — types, translate, and locale detection.
 *
 * The main entry re-exports pure-JS utilities that work in both
 * Node.js and browser environments.
 *
 * For environment-specific factories, import from:
 * - `@moonshot-ai/i18n-shared/node` — Rust-backed Node.js factory
 * - `@moonshot-ai/i18n-shared/web`  — Pure-JS browser factory (with React hook)
 */

export type {
  Locale,
  MessageValue,
  TranslationKey,
  I18nInstance,
} from './types.js';

export { collectLeafKeys } from './types.js';
export { resolveMessage, interpolate, translate } from './core.js';
export { detectLocale, detectLocaleNode, detectLocaleWeb } from './detect.js';