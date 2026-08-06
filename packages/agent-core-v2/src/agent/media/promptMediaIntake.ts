/**
 * `media` domain — prompt-intake normalization of daemon file references.
 *
 * Every daemon reference entering a session's context gets its bytes
 * materialized at the session-canonical location through the session media
 * store (`ISessionMediaStore`) and carries that absolute path, so the
 * persisted reference always points into the session's own `media/` dir —
 * whichever edge (REST prompt route, SDK prompt, steer, …) the message
 * arrived through. When the canonical write fails, the session media store
 * places the bytes in its shared-cache fallback — a read-only session dir must
 * not reject a submittable prompt — with the extension derived like the
 * canonical copy's: hint path, then upload name, then MIME.
 *
 * Intake also authors the paired `<image|video path="…">` tag: edges submit
 * the bare daemon reference, and a successfully materialized reference that
 * no standalone tag claims — pairing is re-evaluated on the rewritten
 * content, so a tag whose path already matches the rewritten reference
 * counts — gets its tag synthesized immediately before it. Normalization is
 * idempotent (a reference already carrying the canonical path with its
 * paired tag passes through untouched) and best effort (an unreadable
 * upload keeps its original reference and gains no tag; the request-time
 * resolver degrades it instead). Reads the referenced bytes through the
 * `file` domain (`IFileService`). Pure orchestration; no scoped service of
 * its own.
 */

import type { IFileService } from '#/app/file/fileService';
import { abortable } from '#/_base/utils/abort';
import type { ContentPart } from '#/kosong/contract/message';

import {
  buildDaemonFileUrl,
  buildMediaPathTag,
  claimingRefIndex,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
  pairMediaPathTagRefs,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';

export interface PromptMediaIntakeDeps {
  readonly files: IFileService;
  readonly mediaStore: ISessionMediaStore;
  readonly signal?: AbortSignal;
}

export async function materializePromptDaemonRefs(
  content: readonly ContentPart[],
  deps: PromptMediaIntakeDeps,
): Promise<readonly ContentPart[]> {
  if (!content.some((part) => daemonFileRefFromPart(part) !== undefined)) return content;

  const pairing = pairMediaPathTagRefs(content);
  const out: ContentPart[] = [];
  let changed = false;
  const pathByRefIndex = new Map<number, string>();

  for (const [index, part] of content.entries()) {
    deps.signal?.throwIfAborted();
    const daemonPart = daemonFileRefFromPart(part);
    if (daemonPart === undefined) {
      out.push(part);
      continue;
    }
    const path = await materializeRef(deps, daemonPart.ref.fileId, daemonPart.ref.path).catch(
      (_error: unknown) => {
        deps.signal?.throwIfAborted();
        return undefined;
      },
    );
    if (path === undefined || path === daemonPart.ref.path) {
      if (path !== undefined) pathByRefIndex.set(index, path);
      out.push(part);
      continue;
    }
    pathByRefIndex.set(index, path);
    out.push(rewriteRefPath(part, daemonPart.ref.fileId, path));
    changed = true;
  }

  for (const tagIndex of pairing.claimedTagIndices) {
    const refIndex = claimingRefIndex(pairing, tagIndex);
    if (refIndex === undefined) continue;
    const path = pathByRefIndex.get(refIndex);
    const tagPart = content[tagIndex];
    if (path === undefined || tagPart?.type !== 'text') continue;
    const tag = matchSingleMediaPathTag(tagPart.text);
    if (tag === undefined || tag.path === path) continue;
    out[tagIndex] = { type: 'text', text: buildMediaPathTag(tag.kind, path) };
    changed = true;
  }

  const finalPairing = pairMediaPathTagRefs(out);
  const authored: ContentPart[] = [];
  let inserted = false;
  for (const [index, part] of out.entries()) {
    const path = pathByRefIndex.get(index);
    if (path !== undefined && !finalPairing.claimedPathByRefIndex.has(index)) {
      const daemonPart = daemonFileRefFromPart(part);
      if (daemonPart !== undefined) {
        authored.push({ type: 'text', text: buildMediaPathTag(daemonPart.kind, path) });
        inserted = true;
      }
    }
    authored.push(part);
  }
  if (inserted) return authored;

  return changed ? out : content;
}

async function materializeRef(
  deps: PromptMediaIntakeDeps,
  fileId: string,
  hintPath: string | undefined,
): Promise<string | undefined> {
  const file =
    deps.signal === undefined
      ? await deps.files.get(fileId)
      : await abortable(deps.files.get(fileId), deps.signal);
  const input = {
    fileId,
    size: file.meta.size,
    name: file.meta.name,
    mimeType: file.meta.media_type,
    hintPath,
  };
  try {
    const path = await deps.mediaStore.materialize({
      ...input,
      stream: () => file.stream(),
      signal: deps.signal,
    });
    if (path !== undefined) return path;
  } catch {
    deps.signal?.throwIfAborted();
  }
  return deps.mediaStore.materializeFallback({
    ...input,
    stream: () => file.stream(),
    signal: deps.signal,
  });
}

function rewriteRefPath(part: ContentPart, fileId: string, path: string): ContentPart {
  const url = buildDaemonFileUrl(fileId, path);
  if (part.type === 'image_url') return { ...part, imageUrl: { ...part.imageUrl, url } };
  if (part.type === 'video_url') return { ...part, videoUrl: { ...part.videoUrl, url } };
  return part;
}
