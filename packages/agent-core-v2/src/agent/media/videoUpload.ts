import type { VideoUploadEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { VideoUploadUnsupportedError } from '#/llm-adapter/contract/errors';
import type { VideoUploader } from '#/llm-adapter/model/media';
import { errorStatusCode } from '@moonshot-ai/core/llm/protocol/errors';
import type { VideoURLPart } from '@moonshot-ai/core/llm/message';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import { ProtocolErrors } from '#/llm-adapter/protocol/errors';

export interface VideoUploadTelemetry {
  readonly client: ITelemetryService;
  readonly props?: Pick<VideoUploadEvent, 'model' | 'provider_type' | 'protocol'>;
}

export function createVideoUploader(
  uploadVideo: VideoUploader | undefined,
  telemetry?: VideoUploadTelemetry,
): VideoUploader | undefined {
  if (uploadVideo === undefined) return undefined;
  if (telemetry === undefined) return (input, options) => uploadVideo(input, options);

  return async (input, options) => {
    const startedAt = Date.now();
    const base = {
      ...telemetry.props,
      mime_type: input.mimeType,
      size_bytes: input.data.length,
    };
    const track = (props: VideoUploadEvent): void => {
      try {
        telemetry.client.track2('video_upload', props);
      } catch {
      }
    };
    try {
      const part = await uploadVideo(input, options);
      track({ ...base, outcome: 'success', duration_ms: Date.now() - startedAt });
      return part;
    } catch (error) {
      track({
        ...base,
        outcome: 'error',
        duration_ms: Date.now() - startedAt,
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      throw error;
    }
  };
}

export function isMediaUploadAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === ProtocolErrors.codes.PROVIDER_AUTH_ERROR) return true;
  const status = errorStatusCode(error);
  return status === 401 || status === 403;
}

export function isVideoUploadUnsupportedError(error: unknown): error is VideoUploadUnsupportedError {
  return error instanceof VideoUploadUnsupportedError;
}

export function inlineVideoSupportedForProtocol(protocol: Protocol): boolean {
  return protocol !== 'openai' && protocol !== 'openai_responses';
}

export function inlineVideoPart(data: Uint8Array, mimeType: string): VideoURLPart {
  const base64 = Buffer.from(data).toString('base64');
  return { type: 'video_url', videoUrl: { url: `data:${mimeType};base64,${base64}` } };
}
