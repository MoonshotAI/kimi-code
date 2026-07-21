/**
 * Maps provider-issued video file ids back to the local `/files` upload they
 * were produced from. When a prompt video is inlined as a provider reference
 * (`ms://<id>`), the transcript no longer names the local file, so UIs
 * resolve the provider id through this map to play the video back from
 * daemon storage (see `GET /files/llm/{llm_id}`).
 *
 * Each mapping is one blob-store key (`llm-video/<llmFileId>` → local file
 * id), so concurrent prompt uploads never lose entries to a read-modify-write
 * race, and the map survives restarts. Ids on both sides of the map are
 * constrained to the provider-id alphabet — the id becomes a storage path
 * segment, and a crafted provider response must not escape the namespace.
 */

import type { IBlobStore } from '@moonshot-ai/agent-core-v2';

const SCOPE = 'llm-video';

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Records one mapping; a provider id outside the safe alphabet is dropped
 * (the prompt itself is unaffected — only playback recovery for that video
 * is lost). Store errors still propagate to the caller.
 */
export async function recordLlmVideoRef(
  blobs: IBlobStore,
  llmFileId: string,
  localFileId: string,
): Promise<void> {
  if (!PROVIDER_ID_RE.test(llmFileId)) return;
  await blobs.put(SCOPE, llmFileId, textEncoder.encode(localFileId));
}

export async function resolveLlmVideoRef(
  blobs: IBlobStore,
  llmFileId: string,
): Promise<string | undefined> {
  if (!PROVIDER_ID_RE.test(llmFileId)) return undefined;
  const data = await blobs.get(SCOPE, llmFileId);
  return data === undefined ? undefined : textDecoder.decode(data);
}
