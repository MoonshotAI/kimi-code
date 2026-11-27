import type { AttachmentKind } from '../../model/wireCodec';

export type { AttachmentKind } from '../../model/wireCodec';

export interface AttachmentEntry {
  attId: string;

  key: string;
  kind: AttachmentKind;
  name: string;
  mediaOrdinal?: number;
  size?: number;

  mediaType?: string;

  lastModified?: number;

  path?: string;

  refCount: number;
  uploading: boolean;

  uploadProgress?: number;
  fileId?: string;

  sessionId?: string;
  error?: string;

  previewUrl?: string;
  thumbnailUrl?: string;
  purpose?: 'browser-screenshot';
  browserAssetId?: string;
  remoteSource?: { sessionId: string; fileId: string };
}

const CLIPBOARD_ATT_ID_PATTERN = /^[0-9a-z]{1,64}$/;
const THUMBNAIL_URL_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,/;
const THUMBNAIL_URL_MAX_LENGTH = 512 * 1024;

export function parseAttachmentThumbnailUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= THUMBNAIL_URL_MAX_LENGTH && THUMBNAIL_URL_PATTERN.test(value) ? value : undefined;
}

function parseRemoteSource(value: unknown): AttachmentEntry['remoteSource'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !/[\s/\\\0]/.test(id) && id !== '.' && id !== '..';
  return validId(source['sessionId']) && validId(source['fileId']) ? { sessionId: source['sessionId'], fileId: source['fileId'] } : undefined;
}

function parseAttachmentEntry(
  raw: unknown,
  boundary: 'draft' | 'clipboard',
): AttachmentEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Partial<AttachmentEntry> & { mentionOrdinal?: unknown };
  if (
    typeof entry.attId !== 'string' ||
    (boundary === 'clipboard' && !CLIPBOARD_ATT_ID_PATTERN.test(entry.attId)) ||
    typeof entry.key !== 'string' ||
    typeof entry.name !== 'string' ||
    (entry.kind !== 'file' && entry.kind !== 'folder' && entry.kind !== 'image' && entry.kind !== 'video')
  ) {
    return null;
  }
  const uploading = entry.uploading === true;
  const ordinal = entry.mediaOrdinal ?? entry.mentionOrdinal;
  return {
    attId: entry.attId,
    key: entry.key,
    kind: entry.kind,
    name: entry.name,
    mediaOrdinal:
      typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal > 0
        ? ordinal
        : undefined,
    size: typeof entry.size === 'number' ? entry.size : undefined,
    mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : undefined,
    lastModified: typeof entry.lastModified === 'number' ? entry.lastModified : undefined,
    path: typeof entry.path === 'string' ? entry.path : undefined,
    refCount:
      boundary === 'draft' && typeof entry.refCount === 'number'
        ? entry.refCount
        : 0,
    uploading: false,
    fileId: typeof entry.fileId === 'string' ? entry.fileId : undefined,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    error:
      typeof entry.error === 'string'
        ? entry.error
        : uploading
          ? 'upload-interrupted'
          : undefined,
    thumbnailUrl: parseAttachmentThumbnailUrl(entry.thumbnailUrl),
    remoteSource: parseRemoteSource(entry.remoteSource),
    purpose: entry.purpose === 'browser-screenshot' ? 'browser-screenshot' : undefined,
    browserAssetId: typeof entry.browserAssetId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.browserAssetId) ? entry.browserAssetId : undefined,
  };
}

export function parseDraftAttachmentEntry(raw: unknown): AttachmentEntry | null {
  return parseAttachmentEntry(raw, 'draft');
}

export function parseClipboardAttachmentEntry(raw: unknown): AttachmentEntry | null {
  return parseAttachmentEntry(raw, 'clipboard');
}

export function newAttId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

export function normalizeAttachmentPath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  let prefix = '';
  if (/^[a-zA-Z]:\//.test(normalized)) {
    prefix = normalized.slice(0, 3);
    normalized = normalized.slice(3);
  } else if (normalized.startsWith('//')) {
    prefix = '//';
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('/')) {
    prefix = '/';
    normalized = normalized.slice(1);
  }
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (prefix === '') segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  return prefix + segments.join('/');
}

export function attachmentKeyFor(args: { kind: AttachmentKind; path?: string; attId: string }): string {
  if (!args.path) return `blob:${args.attId}`;
  const normalized = normalizeAttachmentPath(args.path);
  return `file://${args.kind === 'folder' ? `${normalized}/` : normalized}`;
}

export function serializableAttachmentEntry(entry: AttachmentEntry): AttachmentEntry {
  if (entry.previewUrl === undefined && entry.uploadProgress === undefined) return entry;
  const { previewUrl: _droppedPreview, uploadProgress: _droppedProgress, ...rest } = entry;
  return rest;
}

export function isDraftEntryRecoverable(
  entry: AttachmentEntry,
  sessionId: string | undefined,
): boolean {
  if (entry.kind === 'folder') return true;
  if (entry.uploading || entry.error !== undefined) return false;
  if (entry.fileId === undefined) return false;
  return entry.sessionId === undefined || entry.sessionId === sessionId || sessionId === undefined;
}

function isMediaKind(kind: AttachmentKind): kind is 'image' | 'video' {
  return kind === 'image' || kind === 'video';
}

function validMediaOrdinal(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function withMediaOrdinal(entry: AttachmentEntry, mediaOrdinal: number): AttachmentEntry {
  return { ...entry, mediaOrdinal };
}

export function nextAttachmentMediaOrdinal(entries: readonly AttachmentEntry[]): number {
  let highest = 0;
  for (const entry of entries) {
    if (entry.purpose !== 'browser-screenshot' && isMediaKind(entry.kind) && validMediaOrdinal(entry.mediaOrdinal)) {
      highest = Math.max(highest, entry.mediaOrdinal);
    }
  }
  return highest + 1;
}

export function ensureAttachmentMediaOrdinal(
  entry: AttachmentEntry,
  entries: readonly AttachmentEntry[],
): AttachmentEntry {
  if (!isMediaKind(entry.kind) || entry.purpose === 'browser-screenshot') return entry;
  const occupied = entries.some(
    (candidate) =>
      candidate.attId !== entry.attId &&
      isMediaKind(candidate.kind) &&
      candidate.mediaOrdinal === entry.mediaOrdinal,
  );
  if (validMediaOrdinal(entry.mediaOrdinal) && !occupied) return entry;
  return withMediaOrdinal(entry, nextAttachmentMediaOrdinal(entries));
}

export function reassignAttachmentMediaOrdinal(
  entry: AttachmentEntry,
  entries: readonly AttachmentEntry[],
): AttachmentEntry {
  if (!isMediaKind(entry.kind) || entry.purpose === 'browser-screenshot') return entry;
  return withMediaOrdinal(entry, nextAttachmentMediaOrdinal(entries));
}

export function normalizeAttachmentMediaOrdinals(
  entries: readonly AttachmentEntry[],
): AttachmentEntry[] {
  const reserved = new Map<number, string>();
  let next = 1;
  for (const entry of entries) {
    if (!isMediaKind(entry.kind) || entry.purpose === 'browser-screenshot' || !validMediaOrdinal(entry.mediaOrdinal)) continue;
    if (!reserved.has(entry.mediaOrdinal)) {
      reserved.set(entry.mediaOrdinal, entry.attId);
    }
    next = Math.max(next, entry.mediaOrdinal + 1);
  }
  return entries.map((entry) => {
    if (!isMediaKind(entry.kind) || entry.purpose === 'browser-screenshot') return entry;
    if (
      validMediaOrdinal(entry.mediaOrdinal) &&
      reserved.get(entry.mediaOrdinal) === entry.attId
    ) {
      return entry;
    }
    const mediaOrdinal = next;
    next += 1;
    return withMediaOrdinal(entry, mediaOrdinal);
  });
}

export function rebaseAttachmentMediaOrdinals(
  entries: readonly AttachmentEntry[],
  orderedIds: readonly string[],
): AttachmentEntry[] {
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry] as const));
  const activeMediaIds = orderedIds.filter((attId) => {
    const entry = byAttId.get(attId);
    return entry !== undefined && entry.purpose !== 'browser-screenshot' && isMediaKind(entry.kind);
  });
  const rebased = new Map(activeMediaIds.map((attId, index) => [attId, index + 1] as const));
  const reserved = new Set(rebased.values());
  let next = activeMediaIds.length + 1;
  return entries.map((entry) => {
    if (!isMediaKind(entry.kind) || entry.purpose === 'browser-screenshot') return entry;
    const activeOrdinal = rebased.get(entry.attId);
    if (activeOrdinal !== undefined) return withMediaOrdinal(entry, activeOrdinal);
    if (validMediaOrdinal(entry.mediaOrdinal) && !reserved.has(entry.mediaOrdinal)) {
      reserved.add(entry.mediaOrdinal);
      return entry;
    }
    while (reserved.has(next)) next += 1;
    const mediaOrdinal = next;
    reserved.add(mediaOrdinal);
    next += 1;
    return withMediaOrdinal(entry, mediaOrdinal);
  });
}

export function attachmentReferenceName(
  entry: Pick<AttachmentEntry, 'kind' | 'name' | 'mediaOrdinal' | 'purpose'>,
  labels: { image: string; video: string },
): string {
  if (entry.purpose !== 'browser-screenshot' && isMediaKind(entry.kind) && validMediaOrdinal(entry.mediaOrdinal)) {
    return `${labels[entry.kind]} ${entry.mediaOrdinal}`;
  }
  return entry.name;
}

export function kindSourceFor(
  entries?: readonly AttachmentEntry[],
): ((attId: string) => AttachmentKind | undefined) | undefined {
  if (entries === undefined) return undefined;
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry.kind] as const));
  return (attId) => byAttId.get(attId);
}
