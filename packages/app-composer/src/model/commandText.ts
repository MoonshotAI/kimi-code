import type { Node as PMNode } from 'prosemirror-model';
import type { SourceMappedText } from '@moonshot-ai/app-core/lib';
import { submitNormalizedText } from './inlineLinks';
import { docToText } from './documentCodec';
import { ATTACHMENT_LINK_BASE } from './wireCodec';

export function mayStartWithSlashCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/')) return true;
  return trimmed.startsWith('[') && trimmed.includes(ATTACHMENT_LINK_BASE);
}

const textByDoc = new WeakMap<PMNode, string>();
const normalizedByDoc = new WeakMap<PMNode, SourceMappedText>();

export function docText(doc: PMNode): string {
  let text = textByDoc.get(doc);
  if (text === undefined) {
    text = docToText(doc);
    textByDoc.set(doc, text);
  }
  return text;
}

export function normalizedDocText(doc: PMNode): SourceMappedText {
  let normalized = normalizedByDoc.get(doc);
  if (normalized === undefined) {
    normalized = submitNormalizedText(docText(doc));
    normalizedByDoc.set(doc, normalized);
  }
  return normalized;
}
