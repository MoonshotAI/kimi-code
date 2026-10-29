import type { VideoUploadEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ISessionMediaStore } from './sessionMediaStore';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { WorkspaceConfig } from '#/tool/path-access';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import type { VideoUploader } from '#/llm-adapter/model/media';

export interface RegisterMediaToolsDeps {
  readonly attachmentStore: ISessionMediaStore;
  readonly environment: IAgentEnvironmentService;
  readonly workspace: WorkspaceConfig;
  readonly telemetry?: ITelemetryService;
}

export function registerMediaTools(
  toolRegistry: IAgentToolRegistryService,
  deps: RegisterMediaToolsDeps,
): IDisposable {
  return toolRegistry.register(
    new ReadMediaFileTool(deps.environment, deps.workspace, deps.attachmentStore, deps.telemetry),
  );
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

export interface VideoUploadTelemetry {
  readonly client: ITelemetryService;
  readonly props?: Pick<VideoUploadEvent, 'model' | 'provider_type' | 'protocol'>;
}
