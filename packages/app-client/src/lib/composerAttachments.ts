
import {
  attachmentKeyFor,
  newAttId,
  nextAttachmentMediaOrdinal,
  normalizeAttachmentPath,
} from '@moonshot-ai/app-composer/features/attachment';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import { isModelSupportedImageMime } from '@moonshot-ai/app-core/lib';
import type { PromptAttachment } from '../client/types';

export interface FileAttachmentPlan {
  attId: string;
  entry: AttachmentEntry | null;
  startUpload: boolean;
  resetRemoteIdentity: boolean;
}

export type AttachmentInputSource = 'drop' | 'picker' | 'paste-editor' | 'paste-composer' | 'screenshot';

export function insertsAttachmentReference(
  kind: 'file' | 'image' | 'video',
  source: AttachmentInputSource,
  enabled = false,
): boolean {
  return kind === 'file' || (enabled && kind === 'image' && source === 'paste-editor');
}

export function attachmentKind(mime: string): 'image' | 'video' | 'file' {
  const base = mime.split(';', 1)[0]!.trim().toLowerCase();
  if (isModelSupportedImageMime(base)) return 'image';
  if (base.startsWith('video/')) return 'video';
  return 'file';
}

export function mediaReorderTargetIndex(
  orderedIds: readonly string[],
  mediaIds: readonly string[],
  attId: string,
  to: number,
): number | null {
  const from = mediaIds.indexOf(attId);
  const targetId = mediaIds[to];
  if (from === -1 || targetId === undefined || from === to) return null;
  const fullIndex = orderedIds.indexOf(targetId);
  return fullIndex === -1 ? null : fullIndex;
}

export function planFileAttachment(
  entries: readonly AttachmentEntry[],
  args: { name: string; size: number; path: string | null; mediaType?: string; lastModified?: number; kind?: 'file' | 'image' | 'video' },
): FileAttachmentPlan {
  const kind = args.kind ?? 'file';
  const path = args.path === null ? undefined : normalizeAttachmentPath(args.path);
  if (path !== undefined) {
    const key = attachmentKeyFor({ kind, path, attId: '' });
    const existing = entries.findLast((entry) => entry.key === key && entry.kind === kind);
    if (existing) {
      const versionChanged =
        (existing.size !== undefined && existing.size !== args.size) ||
        (existing.lastModified !== undefined &&
          args.lastModified !== undefined &&
          existing.lastModified !== args.lastModified);
      if (!(existing.uploading && versionChanged)) {
        return {
          attId: existing.attId,
          entry: null,
          startUpload:
            !existing.uploading &&
            (versionChanged || existing.error !== undefined || existing.fileId === undefined),
          resetRemoteIdentity: versionChanged,
        };
      }
    }
  } else {
    let candidates = entries.filter(
      (entry) =>
        entry.kind === kind &&
        entry.path === undefined &&
        entry.error !== undefined &&
        !entry.uploading &&
        entry.name === args.name &&
        (entry.size === undefined || entry.size === args.size),
    );
    if (candidates.length > 1 && args.lastModified !== undefined) {
      const byMtime = candidates.filter((entry) => entry.lastModified === args.lastModified);
      if (byMtime.length === 1) candidates = byMtime;
    }
    if (candidates.length === 1) {
      return {
        attId: candidates[0]!.attId,
        entry: null,
        startUpload: true,
        resetRemoteIdentity: false,
      };
    }
  }
  const attId = newAttId();
  return {
    attId,
    entry: {
      attId,
      key: attachmentKeyFor({ kind, path, attId }),
      kind,
      name: args.name,
      mediaOrdinal:
        kind === 'image' || kind === 'video'
          ? nextAttachmentMediaOrdinal(entries)
          : undefined,
      size: args.size,
      mediaType: args.mediaType,
      lastModified: args.lastModified,
      path,
      refCount: 1,
      uploading: true,
    },
    startUpload: true,
    resetRemoteIdentity: false,
  };
}

export interface FolderAttachmentPlan {
  attId: string;
  name: string;
  entry: AttachmentEntry | null;
}

export function planFolderAttachment(
  entries: readonly AttachmentEntry[],
  rawPath: string,
): FolderAttachmentPlan {
  const path = normalizeAttachmentPath(rawPath);
  const base = path.split('/').pop() ?? rawPath;
  const name = base === '' ? path : `${base}/`;
  const key = attachmentKeyFor({ kind: 'folder', path, attId: '' });
  const existing = entries.find((entry) => entry.key === key);
  if (existing) return { attId: existing.attId, name, entry: null };
  const attId = newAttId();
  return {
    attId,
    name,
    entry: { attId, key, kind: 'folder', name, path, refCount: 1, uploading: false },
  };
}

export function buildSubmitPayload(
  orderedAttIds: readonly string[],
  entries: readonly AttachmentEntry[],
  opts?: { sessionId?: string },
): { promptAttachments: PromptAttachment[]; fileAttIds: string[]; mediaAttIds: string[] } {
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry]));
  const promptAttachments: PromptAttachment[] = [];
  const fileAttIds: string[] = [];
  const mediaAttIds: string[] = [];
  for (const attId of orderedAttIds) {
    const entry = byAttId.get(attId);
    if (!entry) continue;
    if (entry.kind === 'folder') continue;
    if (entry.uploading || entry.error !== undefined || entry.fileId === undefined) continue;
    if (opts !== undefined && entry.sessionId !== undefined && entry.sessionId !== opts.sessionId) continue;
    promptAttachments.push({
      clientId: entry.attId,
      fileId: entry.fileId,
      kind: entry.kind,
      sessionId: entry.sessionId,
      name: entry.name,
      mediaType: entry.mediaType,
      size: entry.size,
      ...(entry.mediaOrdinal === undefined ? {} : { mediaOrdinal: entry.mediaOrdinal }),
    });
    if (entry.kind === 'file') fileAttIds.push(attId);
    else mediaAttIds.push(attId);
  }
  return { promptAttachments, fileAttIds, mediaAttIds };
}

export function pillSubmitBlockers(
  entries: readonly AttachmentEntry[],
  docAttIds?: readonly string[],
  opts?: { sessionId?: string },
): { uploading: boolean; errored: boolean; missing: boolean } {
  let uploading = false;
  let errored = false;
  for (const entry of entries) {
    if (entry.uploading) uploading = true;
    if (entry.error !== undefined) errored = true;
    if (opts !== undefined && entry.sessionId !== undefined && entry.sessionId !== opts.sessionId) errored = true;
  }
  let missing = false;
  if (docAttIds !== undefined) {
    const known = new Set(entries.map((entry) => entry.attId));
    missing = docAttIds.some((attId) => !known.has(attId));
  }
  return { uploading, errored, missing };
}

export function applyEntryPatch(
  entries: readonly AttachmentEntry[],
  attId: string,
  patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
): AttachmentEntry[] {
  return entries.map((entry) => (entry.attId === attId ? { ...entry, ...patch } : entry));
}

export function mergePatchedDraftEntries(
  persisted: readonly AttachmentEntry[],
  attId: string,
  patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
  storeEntry: AttachmentEntry | undefined,
): AttachmentEntry[] {
  const next = applyEntryPatch(persisted, attId, patch);
  if (storeEntry !== undefined && !next.some((entry) => entry.attId === attId)) next.push(storeEntry);
  return next;
}

export function snapshotAttachmentEntries(entries: readonly AttachmentEntry[]): AttachmentEntry[] {
  return entries.map((entry) => ({
    ...entry,
    previewUrl: undefined,
    uploadProgress: undefined,
  }));
}

export function retainAttachmentsForDeparture(
  entries: readonly AttachmentEntry[],
  referencedAttIds: readonly string[],
): AttachmentEntry[] {
  const referenced = new Set(referencedAttIds);
  return entries.filter(
    (entry) =>
      entry.kind === 'image' || entry.kind === 'video' || referenced.has(entry.attId),
  );
}

export function editRefillAttachments(turn: {
  attachments?: readonly TurnAttachment[];
  inlineAttachments?: readonly TurnAttachment[];
}): TurnAttachment[] {
  if (turn.inlineAttachments !== undefined) return [...turn.inlineAttachments];
  return [...(turn.attachments ?? [])];
}

function refillMediaSourceKey(attId: string, url: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return `url:${attId}:${url.length}:${(hash >>> 0).toString(36)}`;
}

export function seedEntriesForTurnAttachments(atts: readonly TurnAttachment[]): AttachmentEntry[] {
  const entries: AttachmentEntry[] = [];
  let fileOrdinal = 0;
  let mediaOrdinal = 0;
  for (const att of atts) {
    if (att.kind !== 'image' && att.kind !== 'video' && att.kind !== 'file') continue;
    const isMedia = att.kind === 'image' || att.kind === 'video';
    const attId = isMedia ? `m${++mediaOrdinal}` : String(++fileOrdinal);
    const kind = att.kind;
    if (att.fileId === undefined) {
      if (!isMedia) continue;
      entries.push({
        attId,
        key: refillMediaSourceKey(attId, att.url),
        kind,
        name: att.name ?? att.kind,
        mediaOrdinal: att.mediaOrdinal ?? mediaOrdinal,
        size: att.size,
        mediaType: att.mediaType,
        refCount: 1,
        uploading: att.url !== '',
        error: att.url === '' ? 'upload-interrupted' : undefined,
        previewUrl: att.url || undefined,
      });
      continue;
    }
    entries.push({
      attId,
      key: att.sessionId !== undefined ? `blob:${att.sessionId}:${att.fileId}` : `blob:${att.fileId}`,
      kind,
      name: att.name ?? att.kind,
      mediaOrdinal: isMedia ? att.mediaOrdinal ?? mediaOrdinal : undefined,
      size: att.size,
      mediaType: att.mediaType,
      refCount: 1,
      uploading: false,
      fileId: att.fileId,
      sessionId: att.sessionId,
    });
  }
  return entries;
}

export function unreferencedSeedFiles(
  atts: readonly TurnAttachment[],
  referencedAttIds: ReadonlySet<string>,
): { att: TurnAttachment; ordinal: number }[] {
  const unreferenced: { att: TurnAttachment; ordinal: number }[] = [];
  let ordinal = 0;
  for (const att of atts) {
    if (att.kind !== 'file') continue;
    ordinal += 1;
    if (att.fileId === undefined) continue;
    if (!referencedAttIds.has(String(ordinal))) unreferenced.push({ att, ordinal });
  }
  return unreferenced;
}

export function unreferencedSeedMedia(
  atts: readonly TurnAttachment[],
  referencedAttIds: ReadonlySet<string>,
): { att: TurnAttachment; ordinal: number }[] {
  const unreferenced: { att: TurnAttachment; ordinal: number }[] = [];
  let ordinal = 0;
  for (const att of atts) {
    if (att.kind !== 'image' && att.kind !== 'video') continue;
    ordinal += 1;
    if (!referencedAttIds.has(`m${ordinal}`)) unreferenced.push({ att, ordinal });
  }
  return unreferenced;
}
