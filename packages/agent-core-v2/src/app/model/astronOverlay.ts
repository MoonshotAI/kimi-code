/**
 * `model` domain (L2) — Astron Coding Plan effective-config overlay.
 *
 * When the astron provider is configured (`providers.astron` exists), this
 * overlay injects all 18 embedded Astron Coding Plan model aliases into the
 * effective `models` section. The injected aliases are stripped from the write
 * path so they never reach `config.toml`.
 *
 * Gated by `KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN` — the overlay is a
 * no-op when the flag is off.
 */

import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { ASTRON_MODEL_DEFS, ASTRON_PROVIDER_KEY } from '@moonshot-ai/kosong';

function isEnabled(): boolean {
  const master = process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  if (master !== undefined) return master !== '0' && master !== 'false';
  const flag = process.env['KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN'];
  return flag !== undefined && flag !== '0' && flag !== 'false';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasAstronProvider(effective: Record<string, unknown>): boolean {
  const providers = asRecord(effective['providers']);
  return providers[ASTRON_PROVIDER_KEY] !== undefined;
}

export const astronModelOverlay: ConfigEffectiveOverlay = {
  apply(effective, _getEnv, validate) {
    if (!isEnabled()) return [];
    if (!hasAstronProvider(effective)) return [];

    const existingModels = asRecord(effective['models']);
    const patched = { ...existingModels };

    for (const def of ASTRON_MODEL_DEFS) {
      const key = `astron/${def.id}`;
      // Don't overwrite models the user has explicitly configured.
      if (key in patched) continue;
      patched[key] = {
        provider: ASTRON_PROVIDER_KEY,
        model: def.id,
        maxContextSize: def.contextLength,
        capabilities: ['tool_use', 'thinking'],
      };
    }

    effective['models'] = validate('models', patched);
    return ['models'];
  },

  strip(domain, value, _rawSnake) {
    if (domain !== 'models') return value;
    const models = asRecord(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(models)) {
      if (!key.startsWith('astron/')) out[key] = val;
    }
    return out;
  },
};

registerConfigOverlay(astronModelOverlay);