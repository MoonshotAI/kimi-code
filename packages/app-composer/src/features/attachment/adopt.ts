import type { AttachmentAttrs } from '../../model';
import {
  attachmentKeyFor,
  ensureAttachmentMediaOrdinal,
  newAttId,
  type AttachmentEntry,
  type AttachmentKind,
} from './entry';

export interface AttachmentAdoptionEditor {
  getText(): string;
  getAttachmentEntries(): AttachmentEntry[];
  insertTextAt(offset: number, text: string): void;
  insertAttachment(attrs: AttachmentAttrs, pos?: number): void;
  upsertAttachmentEntry(entry: AttachmentEntry): void;
}

export interface AdoptAttachmentInput {
  kind: AttachmentKind;
  name: string;
  size?: number;
  mediaType?: string;
  uploading: boolean;
  fileId?: string;
  sessionId?: string;
  error?: string;
  mediaName?: (ordinal: number) => string;
}

export function adoptAttachment(
  editor: AttachmentAdoptionEditor,
  input: AdoptAttachmentInput,
  at?: number,
): string {
  let position: number;
  if (at !== undefined) {
    editor.insertTextAt(at, ' ');
    position = at;
  } else {
    const text = editor.getText();
    position = text.length;
    if (position > 0 && !/\s/.test(text.charAt(position - 1))) {
      editor.insertTextAt(position, ' ');
      position += 1;
    }
  }

  const attId = newAttId();
  const entry = ensureAttachmentMediaOrdinal({
    attId,
    key: attachmentKeyFor({ kind: input.kind, attId }),
    kind: input.kind,
    name: input.name,
    size: input.size,
    mediaType: input.mediaType,
    refCount: 0,
    uploading: input.uploading,
  }, editor.getAttachmentEntries());
  const referenceName =
    entry.mediaOrdinal !== undefined && input.mediaName !== undefined
      ? input.mediaName(entry.mediaOrdinal)
      : input.name;
  editor.insertAttachment(
    { attId, name: referenceName, kind: input.kind },
    position,
  );
  if (input.fileId !== undefined) entry.fileId = input.fileId;
  if (input.sessionId !== undefined) entry.sessionId = input.sessionId;
  if (input.error !== undefined) entry.error = input.error;
  editor.upsertAttachmentEntry(entry);
  return attId;
}
