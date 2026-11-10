import type { ITelemetryService } from '@moonshot-ai/agent-core-v2/app/telemetry/telemetry';
import {
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
  compressBase64ForModel as v2CompressBase64ForModel,
  compressImageForModel as v2CompressImageForModel,
} from '@moonshot-ai/agent-core-v2';
import type {
  CompressBase64Result,
  CompressImageResult,
  ImageCompressionCaptionInput,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';

import type { ImageConfig } from '#/config/index';
import type { TelemetryClient, TelemetryProperties } from '#/telemetry';

export type { CompressBase64Result, CompressImageResult, ImageCompressionCaptionInput };

export interface ImageCompressionTelemetry {
  readonly client: TelemetryClient;
  readonly source: string;
}

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
  readonly telemetry?: ImageCompressionTelemetry;
}

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageConfig | undefined = undefined,
  ) {}

  setConfig(config: ImageConfig | undefined): void {
    this.config = config;
  }

  maxEdgePx(): number {
    return positiveIntFromEnv(this.env, 'KIMI_IMAGE_MAX_EDGE_PX') ?? this.config?.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  }

  readByteBudget(): number {
    return (
      positiveIntFromEnv(this.env, 'KIMI_IMAGE_READ_BYTE_BUDGET') ?? this.config?.readByteBudget ?? READ_IMAGE_BYTE_BUDGET
    );
  }
}

export function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const { telemetry, ...rest } = options;
  return v2CompressImageForModel(bytes, mimeType, {
    ...rest,
    telemetry: toV2TelemetryService(telemetry),
    telemetrySource: telemetry?.source,
  });
}

export function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  const { telemetry, ...rest } = options;
  return v2CompressBase64ForModel(base64, mimeType, {
    ...rest,
    telemetry: toV2TelemetryService(telemetry),
    telemetrySource: telemetry?.source,
  });
}

function toV2TelemetryService(
  telemetry: ImageCompressionTelemetry | undefined,
): ITelemetryService | undefined {
  if (telemetry === undefined) return undefined;
  const client = telemetry.client;
  return {
    track2: (event: string, properties?: TelemetryProperties) => {
      client.track(event, properties);
    },
  } as unknown as ITelemetryService;
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
