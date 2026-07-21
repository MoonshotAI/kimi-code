/**
 * `media` domain (L4) — `image` config-section schema and env bindings.
 *
 * Owns the `[image]` section: the longest-edge ceiling (`max_edge_px`) applied
 * when compressing images for the model, and the raw-byte budget
 * (`read_byte_budget`) for images the model reads for itself (ReadMediaFile's
 * default path). Both are persisted user preferences that also accept an
 * operational env override (`KIMI_IMAGE_MAX_EDGE_PX` /
 * `KIMI_IMAGE_READ_BYTE_BUDGET`); `config` resolves each field as
 * `env > config.toml > default` and re-applies the env binding on every read.
 *
 * While a field's env var is set, `stripEnvBoundFields` restores its env-free
 * raw value before `set`/`replace` persists, so an env override echoed
 * back through a config write can never leak into `config.toml`.
 *
 * The compression support module (`#/agent/media/image-compress`) stays
 * config-agnostic: `ImageConfigBridge` reads this env-resolved section and
 * pushes the two values into that module's resolver seam, so callers that rely
 * on the implicit default (MCP results, prompt ingestion in the apps) honor
 * config/env without each wiring it up.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const IMAGE_SECTION = 'image';

export const IMAGE_MAX_EDGE_ENV = 'KIMI_IMAGE_MAX_EDGE_PX';
export const IMAGE_READ_BYTE_BUDGET_ENV = 'KIMI_IMAGE_READ_BYTE_BUDGET';

export const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const imageEnvBindings: EnvBindings<ImageConfig> = envBindings(ImageConfigSchema, {
  maxEdgePx: { env: IMAGE_MAX_EDGE_ENV, parse: parsePositiveInt },
  readByteBudget: { env: IMAGE_READ_BYTE_BUDGET_ENV, parse: parsePositiveInt },
});

export const stripImageEnv = stripEnvBoundFields(imageEnvBindings);

registerConfigSection(IMAGE_SECTION, ImageConfigSchema, {
  defaultValue: {},
  env: imageEnvBindings,
  stripEnv: stripImageEnv,
});
