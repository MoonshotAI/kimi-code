import type { ContentPart, WireEntry } from './agent-record-types';

const BLOBREF_PROTOCOL = 'blobref:';

function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

/** Convert a `blobref:<mime>;<hash>` URL into a vis-server blob route.
 *  Non-blobref URLs are returned unchanged. */
export function resolveBlobRefUrl(
  url: string,
  sessionId: string,
  agentId: string,
  baseUrl: string = '',
): string {
  if (!isBlobRef(url)) return url;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx === -1) return url;
  const mimeType = rest.slice(0, semiIdx);
  const hash = rest.slice(semiIdx + 1);
  if (hash.length === 0) return url;
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(hash)}?agent=${encodeURIComponent(agentId)}&mime=${encodeURIComponent(mimeType)}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

/** Walk every record in a wire and replace blobref URLs with vis-server
 *  blob routes so the UI can render them. Only mutates `entry.data`;
 *  `entry.raw` is left untouched. */
export function rehydrateWireEntries(
  entries: readonly WireEntry[],
  sessionId: string,
  agentId: string,
  baseUrl: string = '',
): void {
  for (const entry of entries) {
    rehydrateRecord(entry.data as Record<string, unknown>, sessionId, agentId, baseUrl);
  }
}

function rehydrateRecord(
  record: Record<string, unknown>,
  sessionId: string,
  agentId: string,
  baseUrl: string,
): void {
  const type = record['type'];
  if (type === 'turn.prompt' || type === 'turn.steer') {
    rehydrateParts(record['input'] as unknown as ContentPart[], sessionId, agentId, baseUrl);
    return;
  }
  if (type === 'context.append_message') {
    const message = record['message'] as { content: ContentPart[] };
    rehydrateParts(message.content, sessionId, agentId, baseUrl);
    return;
  }
  if (type === 'context.append_loop_event') {
    const event = record['event'] as Record<string, unknown>;
    if (event['type'] === 'tool.result') {
      const result = event['result'] as Record<string, unknown>;
      if (typeof result['output'] !== 'string') {
        rehydrateParts(result['output'] as ContentPart[], sessionId, agentId, baseUrl);
      }
    } else if (event['type'] === 'content.part') {
      rehydrateParts([event['part'] as ContentPart], sessionId, agentId, baseUrl);
    }
    return;
  }
}

function rehydrateParts(
  parts: ContentPart[],
  sessionId: string,
  agentId: string,
  baseUrl: string,
): void {
  for (const part of parts) {
    switch (part.type) {
      case 'image_url':
        part.imageUrl.url = resolveBlobRefUrl(part.imageUrl.url, sessionId, agentId, baseUrl);
        break;
      case 'audio_url':
        part.audioUrl.url = resolveBlobRefUrl(part.audioUrl.url, sessionId, agentId, baseUrl);
        break;
      case 'video_url':
        part.videoUrl.url = resolveBlobRefUrl(part.videoUrl.url, sessionId, agentId, baseUrl);
        break;
      default:
        break;
    }
  }
}

export function isSafeBlobHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}
