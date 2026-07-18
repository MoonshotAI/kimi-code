/**
 * Pure-JS translation core — mirrors the Rust `translation.rs` engine exactly.
 *
 * This is the browser-side fallback when the Rust napi module is unavailable.
 * The logic is identical: `resolve` walks dot-separated keys, `interpolate`
 * replaces `{{param}}` tokens, and `translate` chains both with fallback.
 *
 * Keeping this in sync with `packages/kimi-native-tools/src/translation.rs`
 * ensures that all apps produce identical translations regardless of engine.
 */

import type { Locale, MessageValue } from './types.js';

// ── resolve ──────────────────────────────────────────────────────────────────

/**
 * Walk a dot-separated `key` into a message tree and return the leaf string.
 *
 * Returns `undefined` if the key path doesn't exist or the leaf is not a string.
 */
export function resolveMessage(
  data: MessageValue,
  key: string,
): string | undefined {
  const parts = key.split('.');
  let current: MessageValue | undefined = data;
  for (const part of parts) {
    if (current === undefined || typeof current === 'string') {
      return undefined;
    }
    current = (current as Record<string, MessageValue>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

// ── interpolate ──────────────────────────────────────────────────────────────

/**
 * Replace `{{name}}` placeholders in `template` with values from `params`.
 *
 * Unknown placeholders are left as-is (e.g. `{{missing}}` stays unchanged),
 * matching the Rust engine's behaviour.
 */
export function interpolate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => {
    const value = params[name];
    return value !== undefined ? String(value) : `{{${name}}}`;
  });
}

// ── translate ────────────────────────────────────────────────────────────────

/**
 * Resolve a translation key, then interpolate parameters.
 *
 * Resolution order:
 * 1. Try `locale` (current language).
 * 2. Try `fallback` (usually English).
 * 3. Return the `key` itself as the last resort.
 */
export function translate(
  localeData: MessageValue,
  fallbackData: MessageValue,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw =
    resolveMessage(localeData, key) ??
    resolveMessage(fallbackData, key) ??
    key;
  return params ? interpolate(raw, params) : raw;
}
