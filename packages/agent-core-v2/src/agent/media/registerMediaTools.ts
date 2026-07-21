/**
 * Media tool registration.
 *
 * `ReadMediaFile` is only useful when the active model can consume image or
 * video input, so registration is capability-gated here instead of inside the
 * tool (v1 threw a `SkipThisTool` sentinel from the constructor). In
 * production, `AgentMediaToolsRegistrar` (see `mediaToolsRegistrar.ts`) calls
 * `registerMediaTools` and re-runs it whenever the resolved model or its
 * media capabilities change.
 *
 * `createVideoUploader` is a thin binder over a `ModelRequester`'s optional
 * `uploadVideo`. Auth is already resolved via the requester's auth-provider
 * closure; media tooling doesn't need to know about tokens.
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { VideoUploadEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { WorkspaceConfig } from '#/tool/path-access';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ReadMediaFileTool, type VideoUploader } from '#/agent/media/tools/read-media';

export interface RegisterMediaToolsDeps {
  readonly fs: IHostFileSystem;
  readonly env: IHostEnvironment;
  readonly workspace: WorkspaceConfig;
  readonly capabilities: ModelCapability;
  readonly videoUploader?: VideoUploader;
  readonly telemetry?: ITelemetryService;
}

export function registerMediaTools(
  toolRegistry: IAgentToolRegistryService,
  deps: RegisterMediaToolsDeps,
): IDisposable {
  if (!deps.capabilities.image_in && !deps.capabilities.video_in) {
    return toDisposable(() => {});
  }
  return toolRegistry.register(
    new ReadMediaFileTool(
      deps.fs,
      deps.env,
      deps.workspace,
      deps.capabilities,
      deps.videoUploader,
      deps.telemetry,
    ),
  );
}

export function createVideoUploader(
  requester: Pick<ModelRequester, 'uploadVideo'> | undefined,
  telemetry?: VideoUploadTelemetry,
): VideoUploader | undefined {
  const uploadVideo = requester?.uploadVideo;
  if (uploadVideo === undefined) return undefined;
  const bound = uploadVideo.bind(requester);
  if (telemetry === undefined) return (input) => bound(input);

  return async (input) => {
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
      const part = await bound(input);
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
