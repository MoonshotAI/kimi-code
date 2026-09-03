import type { IFileService } from '#/app/file/fileService';
import { abortable } from '#/_base/utils/abort';
import type { ContentPart } from '#/kosong/contract/message';

import { daemonFileRefFromPart } from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';

export interface PromptMediaIntakeDeps {
  readonly files: IFileService;
  readonly mediaStore: ISessionMediaStore;
  readonly signal?: AbortSignal;
}

export async function materializePromptDaemonRefs(
  content: readonly ContentPart[],
  deps: PromptMediaIntakeDeps,
): Promise<void> {
  for (const part of content) {
    deps.signal?.throwIfAborted();
    const daemonPart = daemonFileRefFromPart(part);
    if (daemonPart === undefined) continue;
    await materializeRef(deps, daemonPart.ref.fileId).catch((_error: unknown) => {
      deps.signal?.throwIfAborted();
      return undefined;
    });
  }
}

async function materializeRef(deps: PromptMediaIntakeDeps, fileId: string): Promise<void> {
  const file =
    deps.signal === undefined
      ? await deps.files.get(fileId)
      : await abortable(deps.files.get(fileId), deps.signal);
  try {
    await deps.mediaStore.materialize({
      fileId,
      size: file.meta.size,
      name: file.meta.name,
      mimeType: file.meta.media_type,
      stream: () => file.stream(),
      signal: deps.signal,
    });
  } catch {
    deps.signal?.throwIfAborted();
  }
}
