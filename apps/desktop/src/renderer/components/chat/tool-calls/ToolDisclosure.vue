<!-- apps/web/src/components/chat/tool-calls/ToolDisclosure.vue -->
<!-- Shared shell for every bespoke tool-call row in the conversation stream.

     Design language (§04 "quiet activity stream"): a tool call is ONE quiet
     borderless line in the message flow — leading glyph, tool-specific
     content composition, trailing meta + status — never a boxed card. A hover
     wash (and the chevron) are the only disclosure affordances; expanded
     content hangs below the line, indented to align with the line's text so it
     reads as belonging to that row.

     Interaction model: the head is a plain <div> whose click toggles the body
     (mouse path); the trailing chevron is a real <button> carrying
     aria-expanded (keyboard path). Keeping interactive elements OUT of the
     head lets tool renderers put genuine buttons in the trailing slot (e.g.
     Agent's "open detail") without nesting a button inside a button.

     The shell owns: row layout / states, the grid-rows expand animation,
     status iconography, keyboard + ARIA, and scroll pinning. Each tool
     renderer fills the slots:
       leading  — 14px glyph area (Icon or iconSvg v-html)
       default  — the line's main content (use the slotted .tl-* primitives)
       trailing — meta chips before the status icon (counts, duration…)
       body     — expanded detail (panels, diffs, lists…)

     One type scale for every stream row (thinking / group caption / tool
     line): 13px UI text with in-line mono and trailing meta one step down at
     12px — hierarchy comes from weight + colour, never from size jumps.
     Colour ladder: the only dark object on a line is the file-name button
     (text colour — the one interactive place to go); the action label
     (Run / Read / Edit…), the mono command / pattern and secondary context
     all sit at --color-text-muted; auxiliary elements (icons, chevrons,
     trailing meta) at --color-text-faint. Everything is regular weight —
     hierarchy is carried by colour alone, never by bold.

     Slotted typography primitives (keep every tool on the same scale):
       .tl-name  action label lead-in (regular weight, muted)
       .tl-dim   secondary text (muted, truncates)
       .tl-faint tertiary text (faint, truncates)
       .tl-mono  monospace snippet (command / path / pattern, truncates)
       .tl-chip  trailing meta (xs faint, e.g. "12 lines")
       .tl-add / .tl-del  diff stat numbers (success / danger) -->
<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot, Tooltip } from '@moonshot-ai/app-ui';
import { track } from '../../../lib/track';

const props = withDefaults(
  defineProps<{
    status: 'running' | 'ok' | 'error' | 'suspended';
    open?: boolean;
    expandable?: boolean;
  }>(),
  { open: false, expandable: false },
);

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);

function toggle(): void {
  if (!props.expandable) return;
  // Only user toggles reach here (head click / chevron button) — programmatic
  // open-state changes by the tool renderers don't emit 'toggle'.
  track('ui_element_toggled', { element: 'tool_call', expanded: !props.open, sample_rate: 1 });
  emit('toggle');
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}

const chevronLabel = computed(() =>
  props.open ? t('tools.disclosure.collapse') : t('tools.disclosure.expand'),
);
</script>

<template>
  <div class="tool-line" :class="{ open, expandable, err: status === 'error' }">
    <div ref="headEl" class="tl-head" :class="{ clickable: expandable }" @click="toggle">
      <span class="tl-ic" aria-hidden="true"><slot name="leading" /></span>
      <span class="tl-main">
        <slot />
        <Tooltip :text="chevronLabel">
          <button
            v-if="expandable"
            class="tl-car"
            type="button"
            :aria-expanded="open"
            :aria-label="chevronLabel"
            @click.stop="toggle"
          >
            <Icon class="tl-car-ic" name="chevron-right" size="sm" aria-hidden="true" />
          </button>
        </Tooltip>
      </span>
      <span class="tl-tail">
        <slot name="trailing" />
        <span class="tl-status" :class="status" role="status" :aria-label="status">
          <Icon v-if="status === 'ok'" name="check" size="sm" />
          <Icon v-else-if="status === 'error'" name="close" size="sm" />
          <StatusDot v-else-if="status === 'suspended'" status="suspended" />
          <StatusDot v-else status="running" />
        </span>
      </span>
    </div>
    <div v-if="expandable" class="tl-body" :class="{ open }" :inert="!open">
      <div class="tl-body-inner">
        <slot name="body" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-line {
  /* Block spacing between stream items is owned by ChatPane; the line itself
     only carries its internal layout. */
}

.tl-head {
  display: flex;
  align-items: center;
  /* Icon-to-content rides the same 4px rhythm as the thinking row — the old
     8px gap (plus a padded icon slot) read as a hole. */
  gap: var(--space-1);
  width: 100%;
  /* The thinking row's rhythm exactly: 4px vertical padding, no side inset,
     line-height decoupled from the reading line-height — a compact ~24px
     line instead of a 30px row. No hover wash: the chevron alone carries the
     disclosure affordance (it deepens on hover). */
  padding: var(--space-1) 0;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-family: var(--font-ui);
  /* The shared stream scale: 13px like the thinking row and the group
     caption — a tool line reads as one more quiet line, not a bigger, bolder
     interruption between them. */
  font-size: var(--text-sm);
  line-height: 1;
  text-align: left;
}
.tl-head.clickable {
  cursor: pointer;
  user-select: none;
}
/* Touch: the head row is the tap target — lift it to the 44px minimum. */
@media (hover: none) {
  .tl-head.clickable {
    min-height: var(--touch-target-min);
  }
}

.tl-ic {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  /* The slot is exactly the glyph (14px) — no padded box around it. */
  flex: none;
  color: var(--color-text-faint);
}

.tl-main {
  flex: 1;
  min-width: 0;
  display: flex;
  /* Centre, not baseline: in-line mono runs one step smaller than the UI
     text, and baseline alignment made a mono-only row (Bash) sit visibly
     off-centre against the icon and the chevron. */
  align-items: center;
  /* In-line content rides the thinking row's 4px rhythm — an 8px gap reads
     as a hole between the file name and its directory / the label and its
     subject. */
  gap: var(--space-1);
}

.tl-tail {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.tl-status {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.tl-status.ok {
  color: var(--color-success);
}
.tl-status.error {
  color: var(--color-danger);
}

/* The disclosure affordance is a real button (keyboard path; the head click
   is the mouse path), hugging the line's text like the thinking row's
   chevron — quiet (no wash of its own), rotating 90° when open. Sized 16px
   so it doesn't stretch the line past the text's own height. */
.tl-car {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  flex: none;
}
.tl-car:hover {
  color: var(--color-text);
}
.tl-car:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
/* Rotation rides directly on the icon's own class (the group caption's
   pattern): a `:first-child` selector depends on the icon component's root
   inheriting this scope id, which functional icon components don't
   guarantee — the chevron then never rotates. */
.tl-car-ic {
  transition: transform var(--duration-base) var(--ease-out);
}
.tool-line.open .tl-car-ic {
  transform: rotate(90deg);
}

/* Expanded detail: opens downward via a grid-template-rows transition (0fr ↔
   1fr animates everywhere; height:auto only interpolates in Chromium). The
   inner needs min-height:0 + overflow:hidden so the 0fr track can collapse
   fully. No left inset — the body starts at the line's own left edge, flush
   with the message stream. */
.tl-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.tl-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.tl-body-inner {
  min-height: 0;
  overflow: hidden;
  padding: 2px var(--space-2) var(--space-1) 0;
}

/* ---- Slotted line-content primitives ---------------------------------- */
/* Every truncating primitive (overflow:hidden for the ellipsis) sets a
   leading that clears the font's ascent + descent rather than inheriting
   the head's line-height: 1 — a 1em line box is shorter than the metrics
   (Inter ≈1.21em, JetBrains Mono ≈1.32em), so descenders (j / p / g / y)
   would be clipped. UI text uses --leading-tight; the mono run uses the
   font's own normal leading (its ≈1.32em exceeds --leading-tight, and
   normal adapts to whatever mono face is actually in use). The row stays
   ~24px: the 16px chevron still drives the head's height. */
.tl-main :slotted(.tl-name) {
  /* The action label is a quiet lead-in word, not the row's anchor: regular
     weight at the muted rung. The dark anchor belongs to the object — the
     file-name button (medium) or the mono command / pattern (text colour). */
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
  flex: none;
}
.tl-main :slotted(.tl-dim) {
  color: var(--color-text-muted);
  line-height: var(--leading-tight);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-main :slotted(.tl-faint) {
  color: var(--color-text-faint);
  line-height: var(--leading-tight);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-main :slotted(.tl-mono) {
  font-family: var(--font-mono);
  /* One step below the 13px line text: a monospace x-height reads larger
     than the UI face at the same size, so 12px sits level next to it. */
  font-size: var(--text-xs);
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  /* Commands and patterns are records of what ran — keep them at the muted
     rung. The only dark object on a line is the file-name button: the one
     interactive place to go. */
  color: var(--color-text-muted);
  line-height: normal;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-main :slotted(.tl-file) {
  /* File-name button inside a line (Read/Edit/Write): the row's anchor, at
     the text colour but regular weight like everything else in the stream —
     hierarchy is carried by colour alone, never by bold. It is a real button
     that opens the file preview; the head is a div, so a nested button is
     valid here — clicks are stop-propagation'd by the tool renderer. */
  font-weight: var(--weight-regular);
  color: var(--color-text);
  line-height: var(--leading-tight);
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  padding: 0 1px;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.tl-main :slotted(.tl-file):hover {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.tl-main :slotted(.tl-file):focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tl-tail :slotted(.tl-pill) {
  font-size: var(--text-xs);
  line-height: 1.5;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  flex: none;
  white-space: nowrap;
}
.tl-tail :slotted(.tl-chip) {
  /* Trailing meta is auxiliary information — it stays at the faint rung of
     the colour ladder so the status glyph remains the strongest signal at
     the right edge. */
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  flex: none;
  white-space: nowrap;
}
.tl-tail :slotted(.tl-add) {
  color: var(--color-success);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  flex: none;
}
.tl-tail :slotted(.tl-del) {
  color: var(--color-danger);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  flex: none;
}
</style>
