import { z } from 'zod';

import {
  isEnvBinding,
  isPlainObject,
  type ConfigSectionContribution,
  type EnvBinding,
  type EnvBindings,
  type GetEnv,
} from '#/features/config/index';

import { MAX_IMAGE_EDGE_PX, READ_IMAGE_BYTE_BUDGET } from '../transform/compress';

export const IMAGE_CONFIG_SECTION = 'image';

export const IMAGE_MAX_EDGE_ENV = 'KIMI_IMAGE_MAX_EDGE_PX';
export const IMAGE_READ_BYTE_BUDGET_ENV = 'KIMI_IMAGE_READ_BYTE_BUDGET';

export const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

export interface ImageLimits {
  readonly readByteBudget: number;
  readonly maxEdgePx: number;
}

export function resolveImageLimits(section: ImageConfig): ImageLimits {
  return {
    readByteBudget: section.readByteBudget ?? READ_IMAGE_BYTE_BUDGET,
    maxEdgePx: section.maxEdgePx ?? MAX_IMAGE_EDGE_PX,
  };
}

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const imageEnvBindings: EnvBindings<ImageConfig> = {
  maxEdgePx: { env: IMAGE_MAX_EDGE_ENV, parse: parsePositiveInt },
  readByteBudget: { env: IMAGE_READ_BYTE_BUDGET_ENV, parse: parsePositiveInt },
};

function resolvesFromEnv(binding: EnvBinding, getEnv: GetEnv): boolean {
  const parse = typeof binding === 'string' ? undefined : binding.parse;
  const names =
    typeof binding === 'string'
      ? [binding]
      : binding.deprecatedEnv === undefined
        ? [binding.env]
        : [binding.env, binding.deprecatedEnv];
  return names.some((name) => {
    const raw = getEnv(name);
    return raw !== undefined && (parse === undefined || parse(raw) !== undefined);
  });
}

function stripEnvBoundFields<T>(
  bindings: EnvBindings<T>,
): (value: T, raw: unknown, getEnv: GetEnv) => T | undefined {
  return (value, raw, getEnv) => {
    if (value === null || typeof value !== 'object') return value;
    if (!isPlainObject(bindings) || isEnvBinding(bindings)) return value;
    const base = isPlainObject(raw) ? raw : {};
    let out: Record<string, unknown> | undefined;
    for (const [field, binding] of Object.entries(bindings)) {
      if (binding === undefined || !isEnvBinding(binding)) continue;
      if (!resolvesFromEnv(binding, getEnv)) continue;
      out ??= { ...(value as Record<string, unknown>) };
      if (base[field] !== undefined) {
        out[field] = base[field];
      } else {
        delete out[field];
      }
    }
    if (out === undefined) return value;
    if (Object.keys(out).length > 0) return out as T;
    return (Object.keys(base).length > 0 ? base : undefined) as T | undefined;
  };
}

export const imageConfigSection: ConfigSectionContribution<ImageConfig> = {
  name: IMAGE_CONFIG_SECTION,
  schema: ImageConfigSchema,
  defaultValue: {},
  envBindings: imageEnvBindings,
  stripEnv: stripEnvBoundFields<ImageConfig>(imageEnvBindings),
};
