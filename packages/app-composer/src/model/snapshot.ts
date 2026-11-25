import type { Node as PMNode } from 'prosemirror-model';
import { composerSchema } from './schema';
import { sessionIdFromMentionPath } from './wireCodec';
import { parseDraftAttachmentEntry, serializableAttachmentEntry, type AttachmentEntry } from '../features/attachment/entry';
import { browserCaptureBindingId, isBrowserReferenceId, parseBrowserCapture, parseBrowserReference, type BrowserCapture, type BrowserReference } from '@moonshot-ai/app-core/browser-reference';

export interface ComposerNodeJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ComposerNodeJson[];
  text?: string;
}

export interface ComposerDocumentSnapshot {
  version: 1;
  doc: ComposerNodeJson;
  attachments: AttachmentEntry[];
  attachmentOrder: string[];
  browserReferences?: BrowserReference[];
  browserCaptures?: BrowserCapture[];
}

const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024;
const MAX_DOCUMENT_NODES = 100_000;
const MAX_ATTACHMENTS = 1_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInlineNode(node: Record<string, unknown>): boolean {
  if (node.content !== undefined || node.marks !== undefined) return false;
  if (node.type === 'text') return typeof node.text === 'string' && node.text.length > 0 && node.attrs === undefined;
  if (node.text !== undefined || !record(node.attrs)) return false;
  const attrs = node.attrs;
  if (node.type === 'browser_reference') return isBrowserReferenceId(attrs.refId) && typeof attrs.label === 'string' && attrs.label.length <= 256;
  if (node.type === 'mention') {
    return (attrs.kind === 'file' || attrs.kind === 'folder' || attrs.kind === 'skill' || attrs.kind === 'session') &&
      typeof attrs.name === 'string' && typeof attrs.path === 'string' &&
      (attrs.rawDest === undefined || typeof attrs.rawDest === 'string');
  }
  if (node.type === 'attachment') {
    return (attrs.kind === 'file' || attrs.kind === 'folder' || attrs.kind === 'image' || attrs.kind === 'video') &&
      typeof attrs.attId === 'string' && attrs.attId.length > 0 && typeof attrs.name === 'string';
  }
  if (node.type === 'pasted_text') return typeof attrs.text === 'string' && attrs.text.length > 0;
  if (node.type === 'quote') {
    return typeof attrs.text === 'string' &&
      (attrs.source === undefined || typeof attrs.source === 'string') &&
      (attrs.comment === undefined || typeof attrs.comment === 'string');
  }
  return false;
}

function withCurrentSessionPaths(paragraph: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(paragraph.content)) return paragraph;
  return {
    ...paragraph,
    content: paragraph.content.map((node: Record<string, unknown>) => {
      const attrs = node.attrs;
      if (node.type !== 'mention' || !record(attrs) || attrs.kind !== 'session' || typeof attrs.path !== 'string') return node;
      return { ...node, attrs: { ...attrs, path: sessionIdFromMentionPath(attrs.path) } };
    }),
  };
}

function parseDocument(value: unknown): PMNode | null {
  if (!record(value) || value.type !== 'doc' || !Array.isArray(value.content) || value.content.length === 0) return null;
  if (value.content.length > MAX_DOCUMENT_NODES || value.text !== undefined || value.marks !== undefined) return null;
  let nodes = 1;
  for (const paragraph of value.content) {
    if (!record(paragraph) || paragraph.type !== 'paragraph' || paragraph.text !== undefined || paragraph.marks !== undefined) return null;
    if (paragraph.content === undefined) continue;
    if (!Array.isArray(paragraph.content)) return null;
    nodes += 1 + paragraph.content.length;
    if (nodes > MAX_DOCUMENT_NODES || !paragraph.content.every((node: unknown) => record(node) && validInlineNode(node))) return null;
  }
  try {
    const doc = composerSchema.nodeFromJSON({ ...value, content: value.content.map(withCurrentSessionPaths) });
    doc.check();
    return doc;
  } catch {
    return null;
  }
}

export function parseComposerSnapshot(value: unknown): ComposerDocumentSnapshot | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.attachments) || !Array.isArray(value.attachmentOrder)) return null;
  if (value.attachments.length > MAX_ATTACHMENTS || value.attachmentOrder.length > MAX_ATTACHMENTS) return null;
  try {
    if (JSON.stringify(value).length > MAX_SNAPSHOT_CHARS) return null;
  } catch {
    return null;
  }
  const doc = parseDocument(value.doc);
  if (doc === null) return null;
  const browserReferences = parseRecords(value.browserReferences, parseBrowserReference);
  const browserCaptures = parseRecords(value.browserCaptures, parseBrowserCapture);
  if (browserReferences === null || browserCaptures === null) return null;
  const attachments: AttachmentEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.attachments) {
    const entry = parseDraftAttachmentEntry(raw);
    if (entry === null || ids.has(entry.attId)) return null;
    ids.add(entry.attId);
    attachments.push(entry);
  }
  const attachmentOrder: string[] = [];
  const ordered = new Set<string>();
  for (const id of value.attachmentOrder) {
    if (typeof id !== 'string' || id.length === 0 || ordered.has(id)) return null;
    ordered.add(id);
    attachmentOrder.push(id);
  }
  return {
    version: 1, doc: doc.toJSON() as ComposerNodeJson, attachments, attachmentOrder,
    ...(browserReferences.length === 0 ? {} : { browserReferences }),
    ...(browserCaptures.length === 0 ? {} : { browserCaptures }),
  };
}

function parseRecords<T extends { id: string }>(value: unknown, parse: (raw: unknown) => T | null): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const records: T[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const record = parse(raw);
    if (record === null || ids.has(record.id)) return null;
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

export function createComposerSnapshot(
  doc: PMNode,
  entries: readonly AttachmentEntry[],
  attachmentOrder: readonly string[],
  browser?: { references: readonly BrowserReference[]; captures: readonly BrowserCapture[] },
): ComposerDocumentSnapshot {
  const needed = new Set(attachmentOrder);
  const refIds = new Set<string>();
  doc.descendants((node) => {
    if (node.type === composerSchema.nodes.attachment) needed.add(node.attrs.attId as string);
    if (node.type === composerSchema.nodes.browser_reference) refIds.add(node.attrs.refId as string);
  });
  const browserReferences = browser?.references.filter((reference) => refIds.has(reference.id)) ?? [];
  const captureIds = new Set(browserReferences.map((reference) => reference.captureId));
  const browserCaptures = browser?.captures.filter((capture) => captureIds.has(capture.id)) ?? [];
  for (const capture of browserCaptures) {
    if (capture.screenshot !== undefined) needed.add(capture.screenshot.attachmentId);
  }
  return {
    version: 1,
    doc: structuredClone(doc.toJSON()) as ComposerNodeJson,
    attachments: entries.filter((entry) => needed.has(entry.attId)).map((entry) => ({ ...serializableAttachmentEntry(entry) })),
    attachmentOrder: [...attachmentOrder],
    ...(browserReferences.length === 0 ? {} : { browserReferences: structuredClone(browserReferences) }),
    ...(browserCaptures.length === 0 ? {} : { browserCaptures: structuredClone(browserCaptures) }),
  };
}

export function withoutComposerSnapshotAttachments(
  snapshot: ComposerDocumentSnapshot,
  attIds: ReadonlySet<string>,
): ComposerDocumentSnapshot {
  if (!snapshot.attachments.some((entry) => attIds.has(entry.attId)) && !snapshot.attachmentOrder.some((id) => attIds.has(id))) return snapshot;
  const paragraphs: PMNode[] = [];
  composerSchema.nodeFromJSON(snapshot.doc).forEach((paragraph) => {
    const inline: PMNode[] = [];
    paragraph.forEach((node) => {
      if (node.type !== composerSchema.nodes.attachment || !attIds.has(node.attrs.attId as string)) inline.push(node);
      else if (node.attrs.name) inline.push(composerSchema.text(node.attrs.name as string));
    });
    paragraphs.push(paragraph.type.create(paragraph.attrs, inline));
  });
  return {
    ...snapshot,
    doc: composerSchema.nodes.doc.create(null, paragraphs).toJSON() as ComposerNodeJson,
    attachments: snapshot.attachments.filter((entry) => !attIds.has(entry.attId)),
    attachmentOrder: snapshot.attachmentOrder.filter((id) => !attIds.has(id)),
  };
}

export function composerSnapshotDocument(snapshot: ComposerDocumentSnapshot): PMNode {
  return composerSchema.nodeFromJSON(snapshot.doc);
}

export function mergeComposerSnapshots(snapshots: readonly ComposerDocumentSnapshot[], onRemap?: (index: number, maps: { attachments: ReadonlyMap<string, string>; references: ReadonlyMap<string, string>; captures: ReadonlyMap<string, string> }) => void): ComposerDocumentSnapshot | null {
  if (snapshots.length === 0) return null;
  const content: ComposerNodeJson[] = [];
  const attachments: AttachmentEntry[] = [];
  const attachmentOrder: string[] = [];
  const used = new Set<string>();
  const usedCaptureIds = new Set<string>();
  const usedRefIds = new Set<string>();
  const browserReferences: BrowserReference[] = [];
  const browserCaptures: BrowserCapture[] = [];
  snapshots.forEach((source, index) => {
    const snapshot = structuredClone(source);
    const remap = new Map<string, string>();
    const ids = new Set([...snapshot.attachmentOrder, ...snapshot.attachments.map((entry) => entry.attId)]);
    for (const capture of snapshot.browserCaptures ?? []) {
      if (capture.screenshot !== undefined) ids.add(capture.screenshot.attachmentId);
    }
    const doc = composerSnapshotDocument(snapshot);
    doc.descendants((node) => {
      if (node.type === composerSchema.nodes.attachment) ids.add(node.attrs.attId as string);
    });
    for (const id of ids) {
      let next = id;
      let suffix = index;
      while (used.has(next)) next = `${id}m${suffix++}`;
      used.add(next);
      remap.set(id, next);
    }
    const captures = new Map<string, string>();
    const refs = new Map<string, string>();
    const freshId = (id: string, taken: Set<string>): string => {
      let next = id;
      let suffix = index;
      while (taken.has(next)) next = `${id.slice(0, 112)}m${suffix++}`;
      taken.add(next);
      return next;
    };
    for (const capture of snapshot.browserCaptures ?? []) {
      const id = freshId(capture.id, usedCaptureIds);
      captures.set(capture.id, id);
      browserCaptures.push({ ...capture, id, bindingId: browserCaptureBindingId(capture), screenshot: capture.screenshot === undefined ? undefined : { ...capture.screenshot, attachmentId: remap.get(capture.screenshot.attachmentId)! } });
    }
    for (const reference of snapshot.browserReferences ?? []) {
      const id = freshId(reference.id, usedRefIds);
      refs.set(reference.id, id);
      if (!captures.has(reference.captureId)) captures.set(reference.captureId, freshId(reference.captureId, usedCaptureIds));
      browserReferences.push({ ...reference, id, captureId: captures.get(reference.captureId)! });
    }
    for (const paragraph of snapshot.doc.content ?? []) {
      for (const node of paragraph.content ?? []) {
        if (node.type === 'attachment' && node.attrs !== undefined) {
          node.attrs['attId'] = remap.get(node.attrs['attId'] as string);
        }
        if (node.type === 'browser_reference' && node.attrs !== undefined) {
          const original = node.attrs['refId'] as string;
          if (!refs.has(original)) refs.set(original, freshId(original, usedRefIds));
          node.attrs['refId'] = refs.get(original);
        }
      }
    }
    if (index > 0) content.push({ type: 'paragraph' });
    content.push(...(snapshot.doc.content ?? []));
    attachments.push(...snapshot.attachments.map((entry) => {
      const attId = remap.get(entry.attId)!;
      return { ...entry, attId, key: entry.key === `blob:${entry.attId}` ? `blob:${attId}` : entry.key };
    }));
    attachmentOrder.push(...snapshot.attachmentOrder.map((id) => remap.get(id)!));
    onRemap?.(index, { attachments: remap, references: refs, captures });
  });
  return {
    version: 1, doc: { type: 'doc', content }, attachments, attachmentOrder,
    ...(browserReferences.length === 0 ? {} : { browserReferences }),
    ...(browserCaptures.length === 0 ? {} : { browserCaptures }),
  };
}
