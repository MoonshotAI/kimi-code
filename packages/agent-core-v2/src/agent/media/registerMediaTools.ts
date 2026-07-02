/**
 * Media tool registration.
 *
 * `ReadMediaFile` is only useful when the active model can consume image or
 * video input, so registration is capability-gated here instead of inside the
 * tool (v1 threw a `SkipThisTool` sentinel from the constructor). The
 * composition root calls `registerMediaTools` from its
 * `initializeBuiltinTools` callback and re-runs it whenever the resolved
 * model capabilities change.
 *
 * `createVideoUploader` is a thin binder over a chat provider's
 * `uploadVideo`. Auth wrapping (force-refresh on 401, etc.) is intentionally
 * left to the composition root, which owns the auth resolver.
 */

import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

import { toDisposable, type IDisposable } from '#/_base/di';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import type { ISessionAgentFileSystem } from '#/session/agentFs';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { ReadMediaFileTool, type VideoUploader } from '#/agent/media/tools/read-media';

export interface RegisterMediaToolsDeps {
  readonly fs: ISessionAgentFileSystem;
  readonly env: IHostEnvironment;
  readonly workspace: WorkspaceConfig;
  readonly capabilities: ModelCapability;
  readonly videoUploader?: VideoUploader;
}

/**
 * Register the media tools against the agent tool registry.
 *
 * Registers `ReadMediaFile` only when the active model supports image or
 * video input. Returns an `IDisposable` that unregisters whatever was
 * registered (a no-op when nothing matched), so the caller can tie it to a
 * lifecycle and re-run registration cleanly on capability changes.
 */
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
    ),
  );
}

/**
 * Bind a chat provider's `uploadVideo` into the `VideoUploader` shape the
 * media tool expects. Returns `undefined` when the provider cannot upload
 * video, in which case the tool falls back to an inline data URL.
 */
export function createVideoUploader(
  provider: Pick<ChatProvider, 'uploadVideo'> | undefined,
): VideoUploader | undefined {
  const uploadVideo = provider?.uploadVideo;
  if (uploadVideo === undefined) return undefined;
  const bound = uploadVideo.bind(provider);
  return (input) => bound(input);
}
