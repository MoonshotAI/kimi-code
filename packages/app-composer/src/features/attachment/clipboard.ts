

import { v4 as randomUUID } from 'uuid';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { browserCaptureBindingId, parseBrowserCapture, parseBrowserReference, type BrowserCapture, type BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import { BrowserReferenceStep, browserReferenceKey, type BrowserReferenceInventory } from '../browser-reference/inventory';
import type { EditorState, Transaction } from 'prosemirror-state';
import {
  composerSchema,
  parseAttachmentLinks,
  reviveQuoteBlockLinks,
  serializeAttachment,
  serializeClipboardSlice,
  splitQuoteBlocks,
  textToDoc,
  type AttachmentAttrs,
} from '../../model';
import { attachmentTargetFor } from './target';
import {
  newAttId,
  parseClipboardAttachmentEntry,
  reassignAttachmentMediaOrdinal,
  serializableAttachmentEntry,
  type AttachmentEntry,
} from './entry';
import { attachmentRegistryKey, type AttachmentRegistryCommand } from './registry';
import {
  activateAttachmentStep,
  attachmentInventoryKey,
} from './inventory';

export function mergePastedEntries(
  current: readonly AttachmentEntry[],
  pasted: readonly AttachmentEntry[],
): { entries: AttachmentEntry[]; attIdRemap: Record<string, string> } {
  const entries = [...current];
  const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry] as const));
  const attIdRemap: Record<string, string> = {};
  for (const entry of pasted) {
    const sameAttId = byAttId.get(entry.attId);
    if (sameAttId !== undefined && sameAttId.key === entry.key) continue;
    const sameKey = byKey.get(entry.key);
    if (sameKey) {

      const versionDiffers =
        entry.kind !== sameKey.kind ||
        (entry.size !== undefined && sameKey.size !== undefined && entry.size !== sameKey.size) ||
        (entry.lastModified !== undefined &&
          sameKey.lastModified !== undefined &&
          entry.lastModified !== sameKey.lastModified);
      if (!versionDiffers) {
        if (sameKey.attId !== entry.attId) attIdRemap[entry.attId] = sameKey.attId;
        continue;
      }

    }
    if (!byAttId.has(entry.attId)) {
      const adopted = reassignAttachmentMediaOrdinal(entry, entries);
      entries.push(adopted);
      byKey.set(adopted.key, adopted);
      byAttId.set(adopted.attId, adopted);
      continue;
    }
    let attId = newAttId();
    while (byAttId.has(attId)) attId = newAttId();
    const adopted = reassignAttachmentMediaOrdinal({ ...entry, attId }, entries);
    entries.push(adopted);
    byKey.set(adopted.key, adopted);
    byAttId.set(attId, adopted);
    attIdRemap[entry.attId] = attId;
  }
  return { entries, attIdRemap };
}

export const COMPOSER_CLIPBOARD_MIME = 'application/x-kimi-composer';

export interface ComposerClipboardPayload {
  v: 1;
  slice: { content?: unknown; openStart?: number; openEnd?: number };
  attachments?: AttachmentEntry[];
  browserReferences?: BrowserReference[];
  browserCaptures?: BrowserCapture[];
}

const MAX_FLAVOR_JSON_LENGTH = 1024 * 1024;

export function parseComposerClipboardPayload(json: string): { slice: Slice; attachments: AttachmentEntry[]; browserReferences: BrowserReference[]; browserCaptures: BrowserCapture[] } | null {
  if (json.length > MAX_FLAVOR_JSON_LENGTH) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const payload = raw as Partial<ComposerClipboardPayload>;
  if (payload.v !== 1 || typeof payload.slice !== 'object' || payload.slice === null) return null;
  if (payload.browserReferences !== undefined && (!Array.isArray(payload.browserReferences) || payload.browserReferences.length > 1_000)) return null;
  if (payload.browserCaptures !== undefined && (!Array.isArray(payload.browserCaptures) || payload.browserCaptures.length > 1_000)) return null;
  let slice: Slice;
  try {
    slice = Slice.fromJSON(composerSchema, payload.slice);
  } catch {
    return null;
  }
  const attachments: AttachmentEntry[] = [];
  for (const rawEntry of Array.isArray(payload.attachments) ? payload.attachments : []) {
    const entry = parseClipboardAttachmentEntry(rawEntry);
    if (entry !== null) attachments.push(entry);
  }
  const browserReferences: BrowserReference[] = [];
  const browserCaptures: BrowserCapture[] = [];
  for (const raw of payload.browserReferences ?? []) {
    const reference = parseBrowserReference(raw);
    if (reference === null) return null;
    browserReferences.push(reference);
  }
  for (const raw of payload.browserCaptures ?? []) {
    const capture = parseBrowserCapture(raw);
    if (capture === null) return null;
    browserCaptures.push(capture);
  }
  return { slice, attachments, browserReferences, browserCaptures };
}

export function remapSliceAttachments(
  slice: Slice,
  attIdRemap: Record<string, string>,
  entries?: readonly AttachmentEntry[],
  referenceName?: (entry: AttachmentEntry) => string,
): Slice {
  if (Object.keys(attIdRemap).length === 0 && entries === undefined) return slice;
  const byAttId = new Map(entries?.map((entry) => [entry.attId, entry] as const) ?? []);
  const fallbackReferenceName = (entry: AttachmentEntry, current: string): string => {
    if ((entry.kind !== 'image' && entry.kind !== 'video') || entry.mediaOrdinal === undefined) return current;
    const match = /^(.*)\s+[1-9]\d*$/.exec(current);
    return match === null ? current : `${match[1]} ${entry.mediaOrdinal}`;
  };
  const remapNode = (node: PMNode): PMNode => {
    if (node.type === composerSchema.nodes.attachment) {
      const attrs = node.attrs as AttachmentAttrs;
      const attId = attIdRemap[attrs.attId] ?? attrs.attId;
      const entry = byAttId.get(attId);
      const name = entry === undefined
        ? attrs.name
        : referenceName?.(entry) ?? fallbackReferenceName(entry, attrs.name);
      return attId === attrs.attId && name === attrs.name
        ? node
        : composerSchema.nodes.attachment.create({ ...attrs, attId, name });
    }
    if (node.isLeaf) return node;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(remapNode(child)));
    return node.copy(Fragment.fromArray(children));
  };
  const content: PMNode[] = [];
  slice.content.forEach((child) => content.push(remapNode(child)));
  return new Slice(Fragment.fromArray(content), slice.openStart, slice.openEnd);
}

export function buildAttachmentClipboardPaste(
  state: EditorState,
  json: string,
  resources?: {
    entries: readonly AttachmentEntry[];
    upsert: (entry: AttachmentEntry) => void;
    referenceName?: (entry: AttachmentEntry) => string;
  },
): Transaction | null {
  const payload = parseComposerClipboardPayload(json);
  if (!payload) return null;
  const current = resources === undefined
    ? [...(attachmentRegistryKey.getState(state)?.values() ?? [])]
    : [...resources.entries];
  const { entries, attIdRemap } = mergePastedEntries(current, payload.attachments);
  let slice = remapSliceAttachments(payload.slice, attIdRemap, entries, resources?.referenceName);
  const browser = browserReferenceKey.getState(state);
  const captures: BrowserCapture[] = [];
  const references: BrowserReference[] = [];
  if (browser !== undefined) {
    const captureIds = new Map<string, string>();
    for (const original of payload.browserCaptures) {
      const capture = { ...original, screenshot: original.screenshot === undefined ? undefined : { ...original.screenshot, attachmentId: attIdRemap[original.screenshot.attachmentId] ?? original.screenshot.attachmentId } };
      const existing = browser.captures.get(capture.id);
      if (existing !== undefined && JSON.stringify(parseBrowserCapture(existing)) !== JSON.stringify(parseBrowserCapture(capture))) {
        capture.bindingId = browserCaptureBindingId(capture);
        capture.id = `bc_${randomUUID()}`;
      }
      captureIds.set(original.id, capture.id);
      captures.push(capture);
    }
    const refById = new Map(payload.browserReferences.map((reference) => [reference.id, reference]));
    const copy = (node: PMNode): PMNode => {
      if (node.type === composerSchema.nodes.browser_reference) {
        const refId = `br_${randomUUID()}`;
        const reference = refById.get(node.attrs.refId as string);
        if (reference !== undefined) {
          let captureId = captureIds.get(reference.captureId);
          if (captureId === undefined) {
            captureId = `bc_${randomUUID()}`;
            captureIds.set(reference.captureId, captureId);
          }
          references.push({ ...reference, id: refId, captureId });
        }
        return node.type.create({ ...node.attrs, refId });
      }
      if (node.isLeaf) return node;
      const children: PMNode[] = [];
      node.forEach((child) => children.push(copy(child)));
      return node.copy(Fragment.fromArray(children));
    };
    const children: PMNode[] = [];
    slice.content.forEach((child) => children.push(copy(child)));
    slice = new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
  }
  const tr = state.tr.replaceSelection(slice);
  for (const reference of references) tr.step(new BrowserReferenceStep(null, reference));
  if (captures.length > 0) tr.setMeta(browserReferenceKey, { captures });
  const currentIds = new Set(current.map((entry) => entry.attId));
  const added = entries.filter((entry) => !currentIds.has(entry.attId));
  if (resources === undefined) {
    const commands: AttachmentRegistryCommand[] = added.map((entry) => ({ type: 'upsert', entry }));
    if (commands.length > 0) tr.setMeta(attachmentRegistryKey, commands);
  } else {
    for (const entry of added) resources.upsert(entry);
  }
  const inventory = attachmentInventoryKey.getState(state);
  if (inventory !== undefined) {
    const referenced = sliceAttachmentAttIds(slice);
    let index = inventory.orderedIds.length;
    for (const attId of referenced) {
      if (inventory.activeIds.has(attId)) continue;
      tr.step(activateAttachmentStep(state, attId, index));
      index += 1;
    }
  }
  return tr.scrollIntoView();
}

export function sliceAttachmentAttIds(slice: Slice): string[] {
  const attIds: string[] = [];
  slice.content.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    if (!attIds.includes(attId)) attIds.push(attId);
    return false;
  });
  return attIds;
}

export function sliceHasQuoteNode(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (node.type === composerSchema.nodes.quote) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

export interface ComposerClipboardCopy {

  plain: string;

  flavor: string;
}

export function buildComposerClipboardCopy(
  slice: Slice,
  lookupEntry: (attId: string) => AttachmentEntry | undefined,
  browser?: BrowserReferenceInventory,
): ComposerClipboardCopy | null {
  const attIds = new Set(sliceAttachmentAttIds(slice));
  const refIds = new Set<string>();
  slice.content.descendants((node) => {
    if (node.type === composerSchema.nodes.browser_reference) refIds.add(node.attrs.refId as string);
  });
  if (slice.content.size === 0) return null;
  const browserReferences = [...refIds].flatMap((id) => browser?.references.get(id) ?? []);
  const captureIds = new Set(browserReferences.map((reference) => reference.captureId));
  const browserCaptures = [...captureIds].flatMap((id) => browser?.captures.get(id) ?? []);
  for (const capture of browserCaptures) {
    if (capture.screenshot !== undefined) attIds.add(capture.screenshot.attachmentId);
  }
  const attachments = [...attIds]
    .map((attId) => lookupEntry(attId))
    .filter((entry): entry is AttachmentEntry => entry !== undefined)
    .map(serializableAttachmentEntry);
  const payload: ComposerClipboardPayload = {
    v: 1, slice: slice.toJSON(), attachments,
    ...(browserReferences.length === 0 ? {} : { browserReferences }),
    ...(browserCaptures.length === 0 ? {} : { browserCaptures }),
  };
  const plain = serializeClipboardSlice(slice, (id, label) => {
    const reference = browser?.references.get(id);
    const capture = reference === undefined ? undefined : browser?.captures.get(reference.captureId);
    return [label, capture?.page.url, reference?.comment].filter(Boolean).join('\n');
  });
  return { plain, flavor: JSON.stringify(payload) };
}

const MAX_STASHED_FLAVORS = 50;

const flavorVault = new Map<string, string>();

export function stashComposerFlavor(flavor: string): string {
  const nonce = newAttId() + newAttId();
  flavorVault.set(nonce, flavor);
  while (flavorVault.size > MAX_STASHED_FLAVORS) {
    const oldest = flavorVault.keys().next().value;
    if (oldest === undefined) break;
    flavorVault.delete(oldest);
  }
  return JSON.stringify({ v: 2, ref: nonce });
}

export function resolveComposerClipboardMime(content: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(content);
    if (typeof raw === 'object' && raw !== null) {
      const envelope = raw as { v?: unknown; ref?: unknown };
      if (envelope.v === 2 && typeof envelope.ref === 'string') return flavorVault.get(envelope.ref);
    }
  } catch {

  }
  return content;
}

export function clearComposerFlavorVault(): void {
  flavorVault.clear();
}

export function remintAttachmentLinkIds(text: string): { text: string; attIdRemap: Record<string, string> } {
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return { text, attIdRemap: {} };
  const remap = new Map<string, string>();
  const taken = new Set<string>();
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    cursor = match.end;
    let minted = remap.get(match.attrs.attId);
    if (minted === undefined) {
      do {
        minted = newAttId();
      } while (taken.has(minted));
      taken.add(minted);
      remap.set(match.attrs.attId, minted);
    }
    out += serializeAttachment({ ...match.attrs, attId: minted });
  }
  out += text.slice(cursor);
  return { text: out, attIdRemap: Object.fromEntries(remap) };
}

export function messageCopyEntryFor<T extends { kind: string; name?: string; fileId?: string; sessionId?: string; size?: number; mediaType?: string; mediaOrdinal?: number }>(
  attrs: AttachmentAttrs,
  target: T | undefined,
): AttachmentEntry {
  const unsendable = target === undefined || target.fileId === undefined;
  return {
    attId: attrs.attId,

    key: target?.fileId
      ? target.sessionId !== undefined
        ? `blob:${target.sessionId}:${target.fileId}`
        : `blob:${target.fileId}`
      : `blob:${attrs.attId}`,

    kind: target !== undefined && (target.kind === 'image' || target.kind === 'video') ? target.kind : attrs.kind,
    name: target?.name ?? attrs.name,
    size: target?.size,
    mediaType: target?.mediaType,
    ...(target?.mediaOrdinal === undefined ? {} : { mediaOrdinal: target.mediaOrdinal }),
    refCount: 0,
    uploading: false,
    fileId: target?.fileId,

    sessionId: target?.sessionId,
    error: unsendable ? 'upload-interrupted' : undefined,
  };
}

export function buildMessageCopyFlavor<T extends { kind: string; fileId?: string; size?: number; mediaType?: string; mediaOrdinal?: number }>(
  text: string,
  attachments: readonly T[] | undefined,
): string | undefined {
  const links = parseAttachmentLinks(text);
  const hasQuoteBlocks = splitQuoteBlocks(text).some((block) => block.type === 'quote');
  if (links.length === 0 && !hasQuoteBlocks) return undefined;

  const doc = textToDoc(reviveQuoteBlockLinks(text), {
    reviveMentions: true,
    attachmentKindFor: (attId) => attachmentTargetFor(attId, attachments)?.kind as 'file' | 'folder' | 'image' | 'video' | undefined,
  });
  const entries: AttachmentEntry[] = links.map((link) =>
    messageCopyEntryFor(link.attrs, attachmentTargetFor(link.attrs.attId, attachments)),
  );
  const payload: ComposerClipboardPayload = {
    v: 1,
    slice: Slice.maxOpen(doc.content).toJSON() ?? {},
    attachments: entries,
  };
  return JSON.stringify(payload);
}
