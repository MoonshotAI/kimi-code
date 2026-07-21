/**
 * Maps provider-issued video file ids back to the local `/files` upload they
 * were produced from. When a prompt video is inlined as a provider reference
 * (`ms://<id>`), the transcript no longer names the local file, so UIs
 * resolve the provider id through this map to play the video back from
 * daemon storage (see `GET /files/llm/{llm_id}`).
 *
 * Each mapping is one blob-store key (`llm-video/<llmFileId>` → local file
 * id), so concurrent prompt uploads never lose entries to a read-modify-write
 * race, and the map survives restarts.
 */

import type { IBlobStore } from '@moonshot-ai/agent-core-v2';

const SCOPE = 'llm-video';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Best-effort persistence is the caller's job; this throws on store errors. */
export async function recordLlmVideoRef(
  blobs: IBlobStore,
  llmFileId: string,
  localFileId: string,
): Promise<void> {
  await blobs.put(SCOPE, llmFileId, textEncoder.encode(localFileId));
}

export async function resolveLlmVideoRef(
  blobs: IBlobStore,
  llmFileId: string,
): Promise<string | undefined> {
  const data = await blobs.get(SCOPE, llmFileId);
  return data === undefined ? undefined : textDecoder.decode(data);
}
