import { createComposerSnapshot, mergeComposerSnapshots, parseBrowserReferenceLinks, parseComposerSnapshot, serializeBrowserReference, textToDoc, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import type { PromptEnvelope } from '../client/types';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';

export function composerSnapshotFromMetadata(metadata: unknown): ComposerDocumentSnapshot | null {
  if (!Array.isArray(metadata)) return null;
  const snapshots: ComposerDocumentSnapshot[] = [];
  let hasRichSnapshot = false;
  for (const entry of metadata) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const snapshot = parseComposerSnapshot(record['kimi_code_composer']);
    if (snapshot !== null) {
      snapshots.push(snapshot);
      hasRichSnapshot = true;
    } else if (typeof record['display_text'] === 'string') {
      snapshots.push(createComposerSnapshot(textToDoc(record['display_text']), [], []));
    } else {
      return null;
    }
  }
  return hasRichSnapshot ? mergeComposerSnapshots(snapshots) : null;
}

export function mergePromptSnapshots(prompts: readonly Pick<PromptEnvelope, 'text' | 'attachments' | 'snapshot'>[], onRemap?: Parameters<typeof mergeComposerSnapshots>[1]): ComposerDocumentSnapshot | undefined {
  if (!prompts.some((prompt) => prompt.snapshot !== undefined)) return undefined;
  const snapshots = prompts.map((prompt, promptIndex) => {
    if (prompt.snapshot !== undefined) return prompt.snapshot;
    const entries = prompt.attachments.map((attachment, index) => ({
      attId: `prompt${promptIndex}attachment${index}`,
      key: `file:${attachment.sessionId ?? ''}:${attachment.fileId}`,
      kind: attachment.kind,
      name: attachment.name ?? attachment.fileId,
      fileId: attachment.fileId,
      sessionId: attachment.sessionId,
      mediaType: attachment.mediaType,
      size: attachment.size,
      refCount: 0,
      uploading: false,
    }));
    return createComposerSnapshot(textToDoc(prompt.text), entries, entries.map((entry) => entry.attId));
  });
  return mergeComposerSnapshots(snapshots, onRemap) ?? undefined;
}

export function prepareMergedPromptSnapshots(prompts: readonly Pick<PromptEnvelope, 'text' | 'attachments' | 'snapshot'>[]) {
  const remapped = prompts.map((prompt) => ({ ...prompt, attachments: [...prompt.attachments] }));
  const snapshot = mergePromptSnapshots(prompts, (index, maps) => {
    const prompt = prompts[index]!;
    let text = '';
    let cursor = 0;
    for (const link of parseBrowserReferenceLinks(prompt.text)) {
      text += prompt.text.slice(cursor, link.start);
      text += serializeBrowserReference({ ...link.attrs, refId: maps.references.get(link.attrs.refId) ?? link.attrs.refId });
      cursor = link.end;
    }
    text += prompt.text.slice(cursor);
    remapped[index] = {
      ...prompt, text,
      attachments: prompt.attachments.map((attachment, attachmentIndex) => ({
        ...attachment,
        clientId: maps.attachments.get(attachment.clientId ?? `prompt${index}attachment${attachmentIndex}`) ?? attachment.clientId,
      })),
    };
  });
  return { snapshot, prompts: remapped };
}

export function rebindComposerSnapshotMedia(snapshot: ComposerDocumentSnapshot, media: readonly TurnAttachment[]): ComposerDocumentSnapshot {
  const result = structuredClone(snapshot);
  const entries = new Map(result.attachments.map((entry) => [entry.attId, entry]));
  const active = result.attachmentOrder.flatMap((id) => {
    const entry = entries.get(id);
    return entry === undefined ? [] : [entry];
  });
  const originalMedia = active.filter((entry) => entry.kind === 'image' || entry.kind === 'video');
  const currentMedia = media.filter((entry) => entry.kind === 'image' || entry.kind === 'video');
  if (originalMedia.length !== currentMedia.length || originalMedia.some((entry, index) => entry.kind !== currentMedia[index]?.kind)) return result;
  originalMedia.forEach((entry, index) => {
    const current = currentMedia[index]!;
    if (current.fileId === undefined) return;
    entry.fileId = current.fileId;
    entry.sessionId = current.sessionId;
    entry.mediaType = current.mediaType ?? entry.mediaType;
    entry.size = current.size ?? entry.size;
  });
  return result;
}
