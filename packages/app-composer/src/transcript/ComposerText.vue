<script setup lang="ts">
import { computed, inject } from 'vue';
import { OpenFileLinkKey, OpenSessionLinkKey } from '@moonshot-ai/app-core/contracts';
import type { TurnAttachment } from '@moonshot-ai/app-core/client/types';
import { mentionActionLine, mentionActionPath, mentionActionSuffix, pastedTextLineCount, pastedTextPillLabel, quotePillLabel, splitInlineSegments, splitQuoteBlocks, unescapeLinkDest, type AttachmentAttrs, type ComposerTextBlock, type InlineSegment, type MentionAttrs } from '../model';
import { COMPOSER_CLIPBOARD_MIME, stashComposerFlavor } from '../features/attachment/clipboard';
import { composerSelectionRange, copyComposerSlice, renderedComposerSlice } from './selectionClipboard';
import { attachmentTargetAttrs, attachmentTargetFor, type AttachmentTargetAttrs } from '../features/attachment/target';
import { mentionIconSvg } from '../features/mention/icons';
import { attachmentKindIconSvg } from '../features/attachment/pill';
import { quoteIconSvg } from '../features/quote/pill';
import { pastedTextIconSvg } from '../features/pasted-text/pill';
import { iconSvg } from '../shared/icons';
import type { BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { ComposerDocumentSnapshot } from '../model/snapshot';
import { snapshotRenderBlocks } from './snapshotBlocks';
import { truncateMentionName } from '../features/mention/pill';
import { setBrowserReferenceTooltip } from '../features/browser-reference/tooltip';

const props = withDefaults(
  defineProps<{
    text: string;
    snapshot?: ComposerDocumentSnapshot;
    browserReferences?: readonly BrowserReference[];
    openBrowserReference?: (refId: string, anchor: HTMLElement) => void;
    interactive?: boolean;
    openFile?: (target: { path: string }) => void;
    attachments?: TurnAttachment[];
    mediaLabels?: { image: string; video: string };
    pastedTextMeta?: (lineCount: number) => string;
  }>(),
  { interactive: true, openFile: undefined, attachments: undefined, mediaLabels: undefined, pastedTextMeta: undefined },
);

type RenderSegment = Exclude<InlineSegment, { type: 'quote' }>;
function bindBrowserTooltip(element: unknown, id: string, label: string): void {
  if (!(element instanceof HTMLElement)) return;
  setBrowserReferenceTooltip(element, () => {
    const reference = (props.snapshot?.browserReferences ?? props.browserReferences)?.find((entry) => entry.id === id);
    const capture = props.snapshot?.browserCaptures?.find((entry) => entry.id === reference?.captureId);
    const thumbnail = props.snapshot?.attachments.find((entry) => entry.attId === capture?.screenshot?.attachmentId)?.thumbnailUrl;
    return { label, reference, capture, thumbnail };
  });
}
type RenderBlock =
  | Extract<ComposerTextBlock, { type: 'quote' | 'sep' }>
  | { type: 'inline'; text: string; segments: RenderSegment[]; annotation?: boolean };

const blocks = computed<RenderBlock[]>(() =>
  props.snapshot !== undefined ? snapshotRenderBlocks(props.snapshot) : splitQuoteBlocks(props.text).map((block) => {
    if (block.type === 'quote' && !block.source) {
      const segments = splitInlineSegments(block.text);
      const segment = segments[0];
      if (segments.length === 1 && segment?.type === 'attachment') {
        return {
          type: 'inline' as const,
          text: block.text,
          annotation: true,
          segments: [{ ...segment, attrs: { ...segment.attrs, comment: block.comment } }],
        };
      }
    }
    if (block.type !== 'inline') return block;
    return {
      type: 'inline' as const,
      text: block.text,
      segments: splitInlineSegments(block.text).map((segment) =>
        segment.type === 'quote' || segment.type === 'pasted-text' ? { type: 'text' as const, value: segment.attrs.text } : segment,
      ),
    };
  }),
);

function browserReferenceComment(id: string): string | undefined {
  return (props.browserReferences ?? props.snapshot?.browserReferences)?.find((reference) => reference.id === id)?.comment;
}

function openBrowserReference(id: string, event: Event): void {
  if (!props.interactive || !(event.currentTarget instanceof HTMLElement)) return;
  event.stopPropagation();
  props.openBrowserReference?.(id, event.currentTarget);
}

function sepTouchesQuote(index: number): boolean {
  const prev = blocks.value[index - 1];
  const next = blocks.value[index + 1];
  return prev?.type === 'quote' || next?.type === 'quote' ||
    (prev?.type === 'inline' && prev.annotation === true) || (next?.type === 'inline' && next.annotation === true);
}

function interactiveAttrs(attrs: MentionAttrs): { tabindex?: number; role?: string } {
  if (!props.interactive || attrs.kind === 'folder') return {};
  if (attrs.kind === 'session') return resolveOpenSessionLink?.() === undefined ? {} : { tabindex: 0, role: 'button' };
  if (attrs.kind === 'skill') return { tabindex: 0, role: 'button' };
  return props.openFile ? { tabindex: 0, role: 'button' } : {};
}

function attachmentPillAttrs(attrs: AttachmentAttrs): AttachmentTargetAttrs {
  const targetAttrs = attachmentTargetAttrs(attrs.attId, props.attachments, props.snapshot?.attachments);
  if (props.interactive) return targetAttrs;
  return { ...targetAttrs, tabindex: undefined, role: undefined };
}

function attachmentKindFor(attrs: AttachmentAttrs): string {
  return attachmentTargetFor(attrs.attId, props.attachments, props.snapshot?.attachments)?.kind ?? attrs.kind;
}

function attachmentNameFor(attrs: AttachmentAttrs): string {
  const target = attachmentTargetFor(attrs.attId, props.attachments, props.snapshot?.attachments);
  const entry = props.snapshot?.attachments.find((entry) => entry.attId === attrs.attId);
  if (entry !== undefined && (entry.kind === 'image' || entry.kind === 'video') && entry.mediaOrdinal !== undefined && props.mediaLabels !== undefined) return `${props.mediaLabels[entry.kind]} ${entry.mediaOrdinal}`;
  const kind = target?.kind ?? attrs.kind;
  if (
    (kind === 'image' || kind === 'video') &&
    target?.mediaOrdinal !== undefined &&
    props.mediaLabels !== undefined
  ) {
    return `${props.mediaLabels[kind]} ${target.mediaOrdinal}`;
  }
  return attrs.name;
}

function snapshotFileAction(attrs: MentionAttrs): { path: string; line: number } | null {
  const basename = attrs.path.split(/[\\/]/).pop() ?? attrs.path;
  if (attrs.name === basename) return null;
  const line = mentionActionLine(attrs.path);
  if (line === undefined) return null;
  return { path: mentionActionPath(attrs.path), line };
}

function actionPathFor(segment: InlineSegment): string | undefined {
  if (segment.type !== 'mention' || (segment.attrs.kind !== 'file' && segment.attrs.kind !== 'folder')) return undefined;
  if (segment.rawDest === '') return snapshotFileAction(segment.attrs)?.path;
  const action = unescapeLinkDest(mentionActionPath(segment.rawDest), false);
  return action !== segment.attrs.path ? action : undefined;
}

const openFileLink = inject(OpenFileLinkKey, undefined);
const resolveOpenSessionLink = inject(OpenSessionLinkKey, undefined);

function onPillClick(segment: InlineSegment, event: Event): void {
  if (segment.type !== 'mention' || !props.interactive) return;
  const openSession = segment.attrs.kind === 'session' ? resolveOpenSessionLink?.() : undefined;
  if (openSession !== undefined) {
    event.preventDefault();
    event.stopPropagation();
    openSession(segment.attrs.path);
    return;
  }
  if (segment.attrs.kind !== 'file' || !props.openFile) return;
  event.preventDefault();
  event.stopPropagation();
  const snapshotAction = segment.rawDest === '' ? snapshotFileAction(segment.attrs) : null;
  const line = snapshotAction?.line ?? mentionActionLine(segment.rawDest);
  const urlSuffix = segment.rawDest === '' ? '' : mentionActionSuffix(segment.rawDest);
  const target = { path: actionPathFor(segment) ?? segment.attrs.path, ...(line === undefined ? {} : { line }), ...(urlSuffix === '' ? {} : { urlSuffix }) };
  if (openFileLink === undefined) props.openFile(target);
  else openFileLink(target, props.openFile);
}

function onPillKeydown(segment: InlineSegment, event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  onPillClick(segment, event);
}

function onCopy(event: ClipboardEvent): void {
  const selection = window.getSelection();
  const root = event.currentTarget as HTMLElement | null;
  if (selection === null || root === null || event.clipboardData === null) return;
  const range = composerSelectionRange(root, selection);
  if (range === null) return;
  const copy = copyComposerSlice(renderedComposerSlice(range.cloneContents(), props.snapshot), props.snapshot, props.attachments);
  if (copy === null) return;
  event.clipboardData.setData('text/plain', copy.plain);
  event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, stashComposerFlavor(copy.flavor));
  event.preventDefault();
}

</script>

<template>
  <span class="composer-text" @copy="onCopy"><template v-for="(block, index) in blocks" :key="index"><span
    v-if="block.type === 'quote'"
    class="quote-pill"
    :tabindex="interactive ? 0 : undefined"
    :data-quote-text="block.text"
    :data-quote-comment="block.comment || undefined"
    :data-quote-comment-sep="block.commentSep"
    :data-quote-source="block.source || undefined"
    :aria-label="block.comment ? `${block.text}\n${block.comment}` : block.text"
  ><span class="quote-pill-icon" aria-hidden="true" v-html="quoteIconSvg()" /><span class="quote-pill-name">{{ quotePillLabel(block.text) }}</span><template
      v-if="block.comment"
    ><span class="quote-pill-comment quote-pill-comment-summary">{{ quotePillLabel(block.comment) }}</span><span class="quote-pill-comment quote-pill-comment-full">{{ block.comment }}</span></template></span><template
    v-else-if="block.type === 'sep'"
  ><span v-if="sepTouchesQuote(index)" class="q-sep">{{ block.text }}</span><template v-else>{{ block.text }}</template></template><template
    v-else
  ><template v-for="(segment, si) in block.segments" :key="si"><span
    v-if="segment.type === 'mention'"
    :class="`mention-pill mention-${segment.attrs.kind}`"
    :data-mention-kind="segment.attrs.kind"
    :data-mention-name="segment.attrs.name"
    :data-mention-path="segment.attrs.path || undefined"
    :data-mention-raw-dest="segment.rawDest || undefined"
    :data-mention-action-path="actionPathFor(segment)"
    v-bind="interactiveAttrs(segment.attrs)"
    @click="onPillClick(segment, $event)"
    @keydown="onPillKeydown(segment, $event)"
  ><span class="mention-pill-icon" aria-hidden="true" v-html="mentionIconSvg(segment.attrs.kind, segment.attrs.path, segment.attrs.name)" /><span class="mention-pill-name">{{ truncateMentionName(segment.attrs.name) }}</span></span><span
    v-else-if="segment.type === 'browser-reference'"
    :ref="(element) => bindBrowserTooltip(element, segment.attrs.refId, segment.attrs.label)"
    class="quote-pill browser-reference-pill"
    :data-browser-ref-id="segment.attrs.refId"
    :data-browser-ref-label="segment.attrs.label"
    :role="interactive && props.openBrowserReference ? 'button' : undefined"
    :tabindex="interactive && props.openBrowserReference ? 0 : undefined"
    @click="openBrowserReference(segment.attrs.refId, $event)"
    @keydown.enter.prevent="openBrowserReference(segment.attrs.refId, $event)"
    @keydown.space.prevent="openBrowserReference(segment.attrs.refId, $event)"
  ><span class="quote-pill-icon" aria-hidden="true" v-html="iconSvg('browser', 'sm')" /><span class="quote-pill-name">{{ truncateMentionName(segment.attrs.label) }}</span><span v-if="browserReferenceComment(segment.attrs.refId)" class="quote-pill-comment">{{ browserReferenceComment(segment.attrs.refId) }}</span></span><span
    v-else-if="segment.type === 'attachment'"
    :class="`attachment-pill attachment-${attachmentKindFor(segment.attrs)}`"
    :data-attachment-id="segment.attrs.attId"
    :data-attachment-kind="attachmentKindFor(segment.attrs)"
    :data-attachment-name="attachmentNameFor(segment.attrs)"
    :data-attachment-comment="segment.attrs.comment || undefined"
    :aria-label="segment.attrs.comment ? `${attachmentNameFor(segment.attrs)}\n${segment.attrs.comment}` : undefined"
    v-bind="attachmentPillAttrs(segment.attrs)"
  ><span class="attachment-pill-icon" aria-hidden="true" v-html="attachmentKindIconSvg(attachmentKindFor(segment.attrs))" /><span class="attachment-pill-name">{{ truncateMentionName(attachmentNameFor(segment.attrs)) }}</span><span v-if="segment.attrs.comment" class="quote-pill-comment">{{ quotePillLabel(segment.attrs.comment) }}</span></span><span
    v-else-if="segment.type === 'pasted-text'"
    class="quote-pill pasted-text-pill"
    :tabindex="interactive ? 0 : undefined"
    :data-pasted-text="segment.attrs.text"
    :aria-label="pastedTextMeta ? `${pastedTextPillLabel(segment.attrs.text)} · ${pastedTextMeta(pastedTextLineCount(segment.attrs.text))}` : pastedTextPillLabel(segment.attrs.text)"
  ><span class="quote-pill-icon" aria-hidden="true" v-html="pastedTextIconSvg()" /><span class="quote-pill-name">{{ pastedTextPillLabel(segment.attrs.text) }}</span><span v-if="pastedTextMeta" class="quote-pill-comment">{{ pastedTextMeta(pastedTextLineCount(segment.attrs.text)) }}</span></span><template v-else>{{ segment.value }}</template></template></template></template></span>
</template>
