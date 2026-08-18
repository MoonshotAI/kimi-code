<!-- packages/app-composer/src/ComposerText.vue -->
<!-- The USER-MESSAGE renderer: renders composer wire text (verbatim text +
     mention links) directly into its final element tree — the parse runs
     once per text change (computed), and the template below produces the
     exact DOM, so there is no mount-time decoration, no MutationObserver,
     and no idempotency to maintain. Pills carry the same classes and
     data-mention-* attributes as the composer's NodeView builder, so the
     mentionTooltip singleton and the global .mention-pill styles apply
     unchanged. -->
<script setup lang="ts">
import { computed } from 'vue';
import { mentionActionPath, serializeMention, splitMentionSegments, type MentionAttrs, type MentionSegment } from './composerTextDoc';
import { mentionHrefToPath } from './mentionLinkPath';
import { mentionIconSvg } from './mentionIcons';
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
  }>(),
  { interactive: true, openFile: undefined },
);

/** text → segments, recomputed only when the text changes; the template
 *  renders this sequence 1:1. */
const segments = computed(() => splitMentionSegments(props.text));

/** Tab semantics for actionable pills in message context. Folder pills stay
 *  inert (no click target); skill pills get button semantics but NO handlers
 *  here — click and Enter/Space route through the mentionTooltip singleton's
 *  document-level capture listeners, same as before. */
function interactiveAttrs(attrs: MentionAttrs): { tabindex?: number; role?: string } {
  if (!props.interactive || attrs.kind === 'folder') return {};
  if (attrs.kind === 'skill') return { tabindex: 0, role: 'button' };
  return props.openFile ? { tabindex: 0, role: 'button' } : {};
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
function actionPathFor(segment: MentionSegment): string | undefined {
  if (segment.type !== 'mention' || segment.attrs.kind === 'skill') return undefined;
  const action = mentionHrefToPath(mentionActionPath(segment.rawDest));
  return action !== segment.attrs.path ? action : undefined;
}

function onPillClick(segment: MentionSegment, event: Event): void {
  if (segment.type !== 'mention' || !props.interactive || segment.attrs.kind !== 'file' || !props.openFile) return;
  event.preventDefault();
  event.stopPropagation();
  props.openFile({ path: actionPathFor(segment) ?? segment.attrs.path });
}

function onPillKeydown(segment: MentionSegment, event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  onPillClick(segment, event);
}

/** Copy from the bubble must yield the WIRE text, not the visible pill
 *  labels: the pill span shows only the (possibly middle-truncated)
 *  basename, so a naive copy irreversibly loses the path and the skill
 *  identity — before pills existed the bubble rendered the raw wire text
 *  and copied verbatim. Pills carry their FULL attrs in data-mention-*,
 *  so a cloned pill becomes its exact serialized link form again. Only
 *  selections fully inside this component are intercepted; a selection
 *  reaching outside keeps the browser default. */
function onCopy(event: ClipboardEvent): void {
  const selection = window.getSelection();
  const root = event.currentTarget as HTMLElement | null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const fragment = range.cloneContents();
  for (const pill of fragment.querySelectorAll('.mention-pill')) {
    const kind = pill.getAttribute('data-mention-kind');
    if (kind !== 'file' && kind !== 'folder' && kind !== 'skill') continue;
    const name = pill.getAttribute('data-mention-name') ?? '';
    const path = pill.getAttribute('data-mention-path') ?? '';
    pill.replaceWith(document.createTextNode(serializeMention({ kind, name, path })));
  }
  event.clipboardData?.setData('text/plain', fragment.textContent ?? '');
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
  ><span class="mention-pill-icon" aria-hidden="true" v-html="mentionIconSvg(segment.attrs.kind, segment.attrs.path, segment.attrs.name)" /><span class="mention-pill-name">{{ truncateMentionName(segment.attrs.name) }}</span></span><template v-else>{{ segment.value }}</template></template></span>
</template>
