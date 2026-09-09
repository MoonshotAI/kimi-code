import type { LlmRemoteErrorMessage } from '#human/llm/errors';
import type { MediaVideoUploader } from '#human/llm/media/upload';
import type { LlmModel } from '#human/llm/model';
import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequester,
} from '#human/llm/requester/requester';
import type { CredentialSource } from '#human/kimi-oauth/credential-source';

export type { CredentialSource } from '#human/kimi-oauth/credential-source';

async function runWithCredentials<T>(
  source: CredentialSource,
  model: LlmModel,
  aborted: () => boolean,
  run: (model: LlmModel) => Promise<T>,
): Promise<T> {
  const resolved = await source.resolve(model);
  try {
    return await run(resolved);
  } catch (error) {
    if (aborted() || source.canRecover?.(resolved, error) !== true) {
      throw error;
    }
  }
  const refreshed = await source.resolve(model, { force: true });
  return run(refreshed);
}

export function withAuth(inner: LlmRequester, source: CredentialSource): LlmRequester {
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const resolved = await source.resolve(config.model);
      let failed: LlmRemoteErrorMessage | undefined;
      await inner.generate({ ...config, model: resolved }, content, {
        ...control,
        onEvent: (event) => {
          if (event.type === 'llm.failed.remote') {
            failed = event.error;
            return;
          }
          control.onEvent?.(event);
        },
      });
      if (failed === undefined) {
        return;
      }
      const failure: LlmRemoteErrorMessage = failed;
      if (control.signal.aborted || source.canRecover?.(resolved, failure) !== true) {
        control.onEvent?.({ type: 'llm.failed.remote', error: failure });
        return;
      }
      const refreshed = await source.resolve(config.model, { force: true });
      await inner.generate({ ...config, model: refreshed }, content, control);
    },
  };
}

export function withAuthUpload(
  inner: MediaVideoUploader,
  source: CredentialSource,
): MediaVideoUploader {
  return (video, options) =>
    runWithCredentials(source, options.model, () => options.signal?.aborted === true, (model) =>
      inner(video, { ...options, model }),
    );
}
