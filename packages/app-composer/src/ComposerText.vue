<!-- packages/app-composer/src/ComposerText.vue -->
<!-- The USER-MESSAGE renderer: renders composer wire text (verbatim text +
     mention links + attachment links) directly into its final element tree
     — the parse runs once per text change (computed), and the template
     below produces the exact DOM, so there is no mount-time decoration, no
     MutationObserver, and no idempotency to maintain. Pills carry the same
     classes and data attributes as the composer's NodeView builders
     (data-mention-* / data-attachment-*), so the mentionTooltip singleton
     and the global pill styles apply unchanged. Message-side attachment
     pills additionally carry their open target (data-attachment-url and
     companions) when the attachments prop resolves their 1..N attId — the
     attribute is what the singleton's click routing and the pointer
     affordance key off. -->
<script setup lang="ts">
import { computed } from 'vue';
import { Slice } from 'prosemirror-model';
import type { TurnAttachment } from '@moonshot-ai/app-core/client/types';
import { mentionActionPath, serializeAttachment, serializeMention, splitInlineSegments, textToDoc, type AttachmentAttrs, type InlineSegment, type MentionAttrs } from './composerTextDoc';
import { COMPOSER_CLIPBOARD_MIME, messageCopyEntryFor, remintAttachmentLinkIds, stashComposerFlavor, type AttachmentEntry, type ComposerClipboardPayload } from './attachmentRegistry';
import { attachmentTargetAttrs, attachmentTargetFor, type AttachmentTargetAttrs } from './attachmentTarget';
import { mentionHrefToPath } from './mentionLinkPath';
import { mentionIconSvg } from './mentionIcons';
import { attachmentIconSvg } from './attachmentPill';
import { truncateMentionName } from './mentionPill';

const props = withDefaults(
  defineProps<{
    /** The wire text (a user message, queued prompt, or activation args). */
    text: string;
    /** Message context (default): file/skill pills are actionable — files
     *  open via the prop, skills activate through the mentionTooltip
     *  singleton's document-level routing. Queue context (false): the whole
     *  row is the edit button, so pills stay inert (no handlers, no tab
     *  semantics — nesting button semantics would be a button-in-button). */
    interactive?: boolean;
    /** Open a file pill's target (preview). The component passes the ACTION
        path: a hand-written link's fragment/query tail (`README.md#usage`)
        is stripped on the raw destination first, while a canonical
        `%23`-filename keeps its literal '#'. The pill's DISPLAY path
        (attrs.path — tooltip, copy) always keeps the full decoded form. */
    openFile?: (target: { path: string }) => void;
    /** The message's attachments, used to revive each attachment pill's open
     *  target: a pill's attId is the submit-time 1..N index over the FILE
     *  attachments (first-mention order — ChatPane passes the turn's
     *  inlineAttachments, which ride in exactly that order). A resolved pill
     *  with a url carries data-attachment-url (+ file id / media type) and
     *  button semantics; activation routes through the mentionTooltip
     *  singleton, same as skill pills. Anything unresolvable (no payload, an
     *  out-of-range index) stays an inert pill. */
    attachments?: TurnAttachment[];
  }>(),
  { interactive: true, openFile: undefined, attachments: undefined },
);

/** text → segments, recomputed only when the text changes; the template
 *  renders this sequence 1:1. */
const segments = computed(() => splitInlineSegments(props.text));

/** Tab semantics for actionable pills in message context. Folder pills stay
 *  inert (no click target); skill pills get button semantics but NO handlers
 *  here — click and Enter/Space route through the mentionTooltip singleton's
 *  document-level capture listeners, same as before. */
function interactiveAttrs(attrs: MentionAttrs): { tabindex?: number; role?: string } {
  if (!props.interactive || attrs.kind === 'folder') return {};
  if (attrs.kind === 'skill') return { tabindex: 0, role: 'button' };
  return props.openFile ? { tabindex: 0, role: 'button' } : {};
}

/** The attachment pill's data attributes + button semantics, stamped from
 *  the attachments prop via attachmentTargetAttrs: metadata (file id, media
 *  type, size) whenever the pill's 1..N attId resolves, and the open
 *  affordance (url + tabindex/role) only when it can actually open (message
 *  context, a non-empty url — an inline-base64 attachment carries no fileId
 *  → inert pill, but its size still reaches the tooltip). The data
 *  attributes are the whole contract — the mentionTooltip singleton reads
 *  them for its click/keyboard routing and the CSS affordance keys off
 *  data-attachment-url, so no handlers are bound here (skill-pill pattern).
 *  Undefined values are dropped by v-bind. */
function attachmentPillAttrs(attrs: AttachmentAttrs): AttachmentTargetAttrs {
  if (!props.interactive || attrs.kind !== 'file') return {};
  return attachmentTargetAttrs(attrs.attId, props.attachments);
}

/** The path a file pill ACTS on (click-to-open, tooltip existence probe), as
 *  opposed to the path it DISPLAYS (attrs.path). Chat links commonly carry an
 *  in-page anchor or query tail (`[Usage](README.md#usage)`) that is not part
 *  of the file path, so the action variant cuts the first UNENCODED `#`/`?`
 *  on the RAW destination — a canonical `%23`-filename (the composer wire
 *  never leaves a literal '#' in a dest) survives, which the decoded display
 *  path could no longer tell apart. Returns undefined when action and display
 *  coincide (and for skill pills, which route through the mentionTooltip
 *  singleton): the pill then carries no data-mention-action-path and the
 *  probe falls back to the display path — same convention as Markdown.vue. */
function actionPathFor(segment: InlineSegment): string | undefined {
  if (segment.type !== 'mention' || segment.attrs.kind === 'skill') return undefined;
  const action = mentionHrefToPath(mentionActionPath(segment.rawDest));
  return action !== segment.attrs.path ? action : undefined;
}

function onPillClick(segment: InlineSegment, event: Event): void {
  if (segment.type !== 'mention' || !props.interactive || segment.attrs.kind !== 'file' || !props.openFile) return;
  event.preventDefault();
  event.stopPropagation();
  props.openFile({ path: actionPathFor(segment) ?? segment.attrs.path });
}

function onPillKeydown(segment: InlineSegment, event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  onPillClick(segment, event);
}

/** A pill element's attachment attrs from its data attributes, or null when
 *  any identity field is missing (a hand-written/foreign pill). */
function readAttachmentAttrs(pill: Element): AttachmentAttrs | null {
  const attId = pill.getAttribute('data-attachment-id') ?? '';
  const kind = pill.getAttribute('data-attachment-kind');
  const name = pill.getAttribute('data-attachment-name') ?? '';
  if (attId === '' || (kind !== 'file' && kind !== 'folder') || name === '') return null;
  return { attId, name, kind };
}

/** Replace every mention pill in the fragment with its serialized link
 *  form — a paste revives the pill from the link. */
function mentionPillsToLinks(fragment: DocumentFragment): void {
  for (const pill of fragment.querySelectorAll('.mention-pill')) {
    const kind = pill.getAttribute('data-mention-kind');
    if (kind !== 'file' && kind !== 'folder' && kind !== 'skill') continue;
    const name = pill.getAttribute('data-mention-name') ?? '';
    const path = pill.getAttribute('data-mention-path') ?? '';
    pill.replaceWith(document.createTextNode(serializeMention({ kind, name, path })));
  }
}

/** Copy from the bubble must yield the WIRE text, not the visible pill
 *  labels: the pill span shows only the (possibly middle-truncated)
 *  basename, so a naive copy irreversibly loses the path and the skill
 *  identity — before pills existed the bubble rendered the raw wire text
 *  and copied verbatim. Pills carry their FULL attrs in data attributes,
 *  so a cloned pill becomes its exact serialized form again: mentions
 *  serialize to their link, attachment pills degrade to the bare name
 *  (the composer-private attId link never travels as plaintext). When the
 *  selection covers attachment pills, a custom clipboard flavor ALSO
 *  carries the selection as a real composer slice plus entries that
 *  inherit the fileId from the message's `attachments` prop (deduped on
 *  `blob:<fileId>`), so a paste back into the composer restores LIVE
 *  pills instead of names or dead stubs — the MIME itself carries only
 *  the process-local vault ref (stashComposerFlavor), never the
 *  fileId-bearing payload. Only selections fully inside
 *  this component are intercepted; a selection reaching outside keeps
 *  the browser default. */
function onCopy(event: ClipboardEvent): void {
  const selection = window.getSelection();
  const root = event.currentTarget as HTMLElement | null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const fragment = range.cloneContents();
  for (const pill of fragment.querySelectorAll('.attachment-pill')) {
    const attrs = readAttachmentAttrs(pill);
    pill.replaceWith(document.createTextNode(attrs?.name ?? pill.textContent ?? ''));
  }
  mentionPillsToLinks(fragment);
  event.clipboardData?.setData('text/plain', fragment.textContent ?? '');

  const flavorFragment = range.cloneContents();
  const flavorAtts: AttachmentAttrs[] = [];
  for (const pill of flavorFragment.querySelectorAll('.attachment-pill')) {
    const attrs = readAttachmentAttrs(pill);
    if (!attrs) {
      pill.replaceWith(document.createTextNode(pill.textContent ?? ''));
      continue;
    }
    if (!flavorAtts.some((seen) => seen.attId === attrs.attId)) flavorAtts.push(attrs);
    pill.replaceWith(document.createTextNode(serializeAttachment(attrs)));
  }
  if (flavorAtts.length > 0) {
    mentionPillsToLinks(flavorFragment);
    // Re-mint the attIds before building the flavor: a bubble's ids are
    // message-scoped (submit-time 1..N indexes), so two bubbles can carry the
    // SAME id for DIFFERENT files — pasting both into a composer would
    // otherwise collide on their blob:<attId> keys and silently conflate the
    // entries (see remintAttachmentLinkIds).
    const { text: flavorText, attIdRemap } = remintAttachmentLinkIds(flavorFragment.textContent ?? '');
    const attachments: AttachmentEntry[] = flavorAtts.map((attrs) => {
      const attId = attIdRemap[attrs.attId] ?? attrs.attId;
      // The message's file attachments ride the `attachments` prop (1..N in
      // the same order as the wire indexes) — the entry inherits the fileId
      // (and dedups on it), so a pasted pill is a LIVE attachment: no
      // re-upload, submit-ready. An unresolvable pill (no target at all, or
      // a fileId-less inline-base64 target) can never be re-sent, so it
      // comes back marked unsendable — see messageCopyEntryFor, the single
      // constructor both copy paths share.
      const target = attachmentTargetFor(attrs.attId, props.attachments);
      return messageCopyEntryFor({ ...attrs, attId }, target);
    });
    // The flavor slice is the selection's wire text re-parsed with pill
    // revival — mentions and attachments both come back as nodes, and the
    // maxOpen slice merges into the paragraph the paste lands in.
    const doc = textToDoc(flavorText, { reviveMentions: true });
    const payload: ComposerClipboardPayload = { v: 1, slice: Slice.maxOpen(doc.content).toJSON() ?? {}, attachments };
    event.clipboardData?.setData(COMPOSER_CLIPBOARD_MIME, stashComposerFlavor(JSON.stringify(payload)));
  }
  event.preventDefault();
}
</script>

<template>
  <!-- The inline wrapper is layout-neutral (the content is one inline
       flow); it exists to carry the copy interceptor. -->
  <span class="composer-text" @copy="onCopy"><template v-for="(segment, index) in segments" :key="index"><span
    v-if="segment.type === 'mention'"
    :class="`mention-pill mention-${segment.attrs.kind}`"
    :data-mention-kind="segment.attrs.kind"
    :data-mention-name="segment.attrs.name"
    :data-mention-path="segment.attrs.path || undefined"
    :data-mention-action-path="actionPathFor(segment)"
    v-bind="interactiveAttrs(segment.attrs)"
    @click="onPillClick(segment, $event)"
    @keydown="onPillKeydown(segment, $event)"
  ><span class="mention-pill-icon" aria-hidden="true" v-html="mentionIconSvg(segment.attrs.kind, segment.attrs.path, segment.attrs.name)" /><span class="mention-pill-name">{{ truncateMentionName(segment.attrs.name) }}</span></span><span
    v-else-if="segment.type === 'attachment'"
    :class="`attachment-pill attachment-${segment.attrs.kind}`"
    :data-attachment-id="segment.attrs.attId"
    :data-attachment-kind="segment.attrs.kind"
    :data-attachment-name="segment.attrs.name"
    v-bind="attachmentPillAttrs(segment.attrs)"
  ><span class="attachment-pill-icon" aria-hidden="true" v-html="attachmentIconSvg()" /><span class="attachment-pill-name">{{ truncateMentionName(segment.attrs.name) }}</span></span><template v-else>{{ segment.value }}</template></template></span>
</template>
