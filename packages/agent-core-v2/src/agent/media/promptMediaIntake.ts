/**
 * `media` domain — prompt-intake materialization of daemon file references.
 *
 * Every daemon reference entering a session's context gets its bytes
 * materialized at the session-canonical location through the session media
 * store (`ISessionMediaStore`), whichever edge (REST prompt route, SDK
 * prompt, steer, …) the message arrived through. The copy's extension is
 * derived from the upload name, then MIME. The reference itself is never
 * rewritten: it stays the bare `kimi-file://<fileId>` form, and the display
 * path is derived from the store by file id at read time, so nothing
 * machine-bound is persisted.
 *
 * Materialization is idempotent (an already-materialized copy whose size
 * matches is kept) and best effort (an unreadable upload or a failed
 * canonical write is skipped; the request-time resolver serves the reference
 * from the daemon upload while it lives and degrades it afterwards). Reads
 * the referenced bytes through the `file` domain (`IFileService`). Pure
 * orchestration; no scoped service of its own.
 */

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
