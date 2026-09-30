import type { ImageConfig } from '@moonshot-ai/harness-core';
import {
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
} from '@moonshot-ai/harness-core/features/media/transform/compress';
import {
  IMAGE_MAX_EDGE_ENV,
  IMAGE_READ_BYTE_BUDGET_ENV,
} from '@moonshot-ai/harness-core/features/media/state/configSection';

export {
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  compressBase64ForModel,
  compressImageForModel,
} from '@moonshot-ai/harness-core/features/media/transform/compress';
export type {
  CompressBase64Result,
  CompressImageOptions,
  CompressImageResult,
  ImageCompressionCaptionInput,
} from '@moonshot-ai/harness-core/features/media/transform/compress';

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageConfig | undefined = undefined,
  ) {}

  setConfig(config: ImageConfig | undefined): void {
    this.config = config;
  }

  maxEdgePx(): number {
    return (
      positiveIntFromEnv(this.env, IMAGE_MAX_EDGE_ENV) ?? this.config?.maxEdgePx ?? MAX_IMAGE_EDGE_PX
    );
  }

  readByteBudget(): number {
    return (
      positiveIntFromEnv(this.env, IMAGE_READ_BYTE_BUDGET_ENV) ??
      this.config?.readByteBudget ??
      READ_IMAGE_BYTE_BUDGET
    );
  }
}

function positiveIntFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
