import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

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

export const imageConfigSection: ConfigSectionContribution<ImageConfig> = {
  name: IMAGE_CONFIG_SECTION,
  schema: ImageConfigSchema,
  defaultValue: {},
  envBindings: {
    maxEdgePx: { env: IMAGE_MAX_EDGE_ENV, parse: parsePositiveInt },
    readByteBudget: { env: IMAGE_READ_BYTE_BUDGET_ENV, parse: parsePositiveInt },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.maxEdgePx;
    delete out.readByteBudget;
    return out;
  },
};
