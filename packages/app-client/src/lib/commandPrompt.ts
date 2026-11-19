import { composerSnapshotDocument, createComposerSnapshot, docToText, textOffsetToPos, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import type { PromptAttachment, PromptEnvelopeContent } from '../client/types';
import { composerDisplayText } from './browserReferenceSubmission';

export function commandPromptContent(cmd: string, attachments: PromptAttachment[], snapshot?: ComposerDocumentSnapshot): PromptEnvelopeContent & { attachments: PromptAttachment[] } {
  const command = /^\/\S+/.exec(cmd)?.[0] ?? '';
  const text = cmd.slice(command.length).trim();
  if (snapshot === undefined) return { text, attachments: [...attachments] };
  const doc = composerSnapshotDocument(snapshot);
  const original = docToText(doc);
  const leading = original.length - original.trimStart().length;
  if (original.slice(leading, leading + command.length) !== command) throw new Error('Command snapshot prefix does not match');
  const argument = original.slice(leading + command.length);
  const offset = leading + command.length + argument.length - argument.trimStart().length;
  const argumentDoc = doc.cut(textOffsetToPos(doc, offset));
  const saved = createComposerSnapshot(argumentDoc, snapshot.attachments, snapshot.attachmentOrder, {
    references: snapshot.browserReferences ?? [], captures: snapshot.browserCaptures ?? [],
  });
  return { text, attachments: [...attachments], snapshot: saved };
}

export function commandArgumentText(cmd: string, snapshot?: ComposerDocumentSnapshot): string {
  const content = commandPromptContent(cmd, [], snapshot?.browserReferences?.length ? snapshot : undefined);
  return content.snapshot === undefined ? content.text : composerDisplayText(content.snapshot).trim();
}
