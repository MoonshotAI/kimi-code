import type { ProviderMediaContribution } from '#/llm/media/upload';
import { modelKey, type LlmModel } from '#/llm/model';

import { KimiFiles } from './files';
import { KIMI_DEFAULT_BASE_URL } from './trait';

const filesByModel = new Map<string, KimiFiles>();

function resolveFiles(model: LlmModel): KimiFiles {
  const key = modelKey(model);
  let files = filesByModel.get(key);
  if (files === undefined) {
    files = new KimiFiles({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl ?? KIMI_DEFAULT_BASE_URL,
      defaultHeaders:
        model.defaultHeaders === undefined ? undefined : { ...model.defaultHeaders },
    });
    filesByModel.set(key, files);
  }
  return files;
}

export const kimiMediaContribution: ProviderMediaContribution = {
  uploadVideo: (video, { model, signal }) => resolveFiles(model).uploadVideo(video, { signal }),
};
