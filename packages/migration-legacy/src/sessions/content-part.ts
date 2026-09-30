import { existsSync } from 'node:fs';

export type NormalizedContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'think'; readonly think: string; readonly encrypted?: string }
  | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string; readonly id?: string } }
  | { readonly type: 'audio_url'; readonly audioUrl: { readonly url: string; readonly id?: string } }
  | { readonly type: 'video_url'; readonly videoUrl: { readonly url: string; readonly id?: string } };

export function normalizeContentPart(part: unknown): NormalizedContentPart {
  if (typeof part !== 'object' || part === null) {
    return { type: 'text', text: `[unsupported content: ${JSON.stringify(part)}]` };
  }
  const p = part as Record<string, unknown>;

  switch (p['type']) {
    case 'text':
      return { type: 'text', text: coerceToString(p['text']) };

    case 'think': {
      const encrypted = p['encrypted'];
      const think = coerceToString(p['think']);
      if (typeof encrypted === 'string' && encrypted.length > 0) {
        return { type: 'think', think, encrypted };
      }
      return { type: 'think', think };
    }

    case 'image':
      return convertMediaPart('image', 'image_url', 'imageUrl', p);
    case 'audio':
      return convertMediaPart('audio', 'audio_url', 'audioUrl', p);
    case 'video':
      return convertMediaPart('video', 'video_url', 'videoUrl', p);

    case 'image_url':
      return convertMediaPart('image', 'image_url', 'imageUrl', asMediaRecord(p['image_url']));
    case 'audio_url':
      return convertMediaPart('audio', 'audio_url', 'audioUrl', asMediaRecord(p['audio_url']));
    case 'video_url':
      return convertMediaPart('video', 'video_url', 'videoUrl', asMediaRecord(p['video_url']));

    default:
      return { type: 'text', text: `[unsupported content: ${JSON.stringify(part)}]` };
  }
}

function asMediaRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Safely coerce an unknown value to string for text fields. Avoids
 * `[object Object]` from accidental object stringification — those become
 * JSON instead. Strings pass through unchanged; null/undefined → ''. */
function coerceToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function convertMediaPart(
  kind: 'image' | 'audio' | 'video',
  newType: 'image_url' | 'audio_url' | 'video_url',
  _fieldName: 'imageUrl' | 'audioUrl' | 'videoUrl',
  p: Record<string, unknown>,
): NormalizedContentPart {
  const url = p['url'];
  if (typeof url !== 'string' || url.length === 0) {
    return { type: 'text', text: `[${kind} missing url]` };
  }
  // If url is a local file path (no scheme) and file is gone, mark expired.
  if (!/^[a-z]+:\/\//i.test(url) && url.startsWith('/') && !existsSync(url)) {
    return { type: 'text', text: `[${kind} expired]` };
  }
  const id = typeof p['id'] === 'string' ? p['id'] : undefined;
  const obj = id === undefined ? { url } : { url, id };
  switch (newType) {
    case 'image_url':
      return { type: 'image_url', imageUrl: obj };
    case 'audio_url':
      return { type: 'audio_url', audioUrl: obj };
    case 'video_url':
      return { type: 'video_url', videoUrl: obj };
  }
}
