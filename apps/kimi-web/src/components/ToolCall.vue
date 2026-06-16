<!-- apps/kimi-web/src/components/ToolCall.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolCall, ToolMedia } from '../types';
import { toolLabel, toolGlyph, toolChip, toolSummary } from '../lib/toolMeta';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    /** Mobile bubble layout: drop the 33px gutter indent + use a softer radius. */
    mobile?: boolean;
    /** Position inside a consecutive run of non-media tool cards. */
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
  }>(),
  { mobile: false, stackPosition: 'single' },
);
const emit = defineEmits<{
  openMedia: [media: ToolMedia];
}>();
const isRunningBash = computed(() => props.tool.status === 'running' && /^bash$/i.test(props.tool.name));
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => hasOutput.value || isRunningBash.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

function toggle() {
  if (canExpand.value) open.value = !open.value;
}

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status, props.tool.name] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) {
      open.value = true;
    }
  },
);

const mark = () => (props.tool.status === 'error' ? '✕' : '✓');

const label = () => toolLabel(props.tool.name);
const glyph = () => toolGlyph(props.tool.name);
const summary = () => toolSummary(props.tool.name, props.tool.arg);
// Expanded body has room to wrap → show the full, un-clipped summary (no `…`).
const summaryFull = () => toolSummary(props.tool.name, props.tool.arg, true);
const chip = () => toolChip({
  name: props.tool.name,
  arg: props.tool.arg,
  output: props.tool.output,
  timing: props.tool.timing,
  status: props.tool.status,
});

const isError = () => props.tool.status === 'error';
const media = computed(() => (props.tool.status === 'ok' ? props.tool.media : undefined));

function basename(path: string): string {
  return path.split(/[\\/]+/).pop() || path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const mediaTitle = computed(() => {
  const m = media.value;
  if (!m) return '';
  const parts = [m.path ? basename(m.path) : toolLabel(props.tool.name)];
  if (m.mimeType) parts.push(m.mimeType);
  if (m.bytes !== undefined) parts.push(formatBytes(m.bytes));
  if (m.dimensions) parts.push(m.dimensions);
  return parts.join(' · ');
});

function openMediaPreview(): void {
  const m = media.value;
  if (m?.kind === 'image') emit('openMedia', m);
}
</script>

<template>
  <div v-if="media" class="media-tool" :class="{ mob: mobile }">
    <div class="media-title" :title="media.path || mediaTitle">{{ mediaTitle }}</div>
    <button
      v-if="media.kind === 'image'"
      type="button"
      class="media-image-button"
      :title="media.path || mediaTitle"
      @click="openMediaPreview"
    >
      <img
        class="media-image"
        :src="media.url"
        :alt="media.path ? basename(media.path) : mediaTitle"
        loading="lazy"
      />
    </button>
    <video
      v-else-if="media.kind === 'video'"
      class="media-video"
      :src="media.url"
      controls
      preload="metadata"
    />
    <audio
      v-else
      class="media-audio"
      :src="media.url"
      controls
    />
  </div>

  <div
    v-else
    class="box"
    :class="{
      open,
      err: isError(),
      mob: mobile,
      stacked: stackPosition !== 'single',
      'stack-first': stackPosition === 'first',
      'stack-middle': stackPosition === 'middle',
      'stack-last': stackPosition === 'last',
    }"
  >
    <div class="bh" @click="toggle">
      <svg class="car" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline :points="open ? '4,6 8,10 12,6' : '6,4 10,8 6,12'"/>
      </svg>
      <!-- inline SVG glyph -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span v-if="glyph()" class="gl" v-html="glyph()" aria-hidden="true" />
      <span class="a">{{ label() }}</span>
      <!-- Summary lives on the header while collapsed; once expanded it moves
           into the card body (below) so the header stays clean. -->
      <span v-if="!open" class="p" :title="summary()">{{ summary() }}</span>
      <span class="rt">
        <span class="chip" v-if="chip()">{{ chip() }}</span>
        <span
          v-if="tool.status === 'running'"
          class="spin"
          role="status"
          aria-label="running"
        />
        <span v-else :class="tool.status === 'ok' ? 'ok' : 'er'">{{ mark() }}</span>
        <span v-if="tool.timing && tool.name !== 'bash'" class="tm"> {{ tool.timing }}</span>
      </span>
    </div>
    <div v-if="open" class="bb">
      <!-- When expanded, the command/summary moves here (and is hidden from the
           header) so it shows exactly once. -->
      <div v-if="summaryFull()" class="bb-summary">{{ summaryFull() }}</div>
      <div v-if="!hasOutput" class="bb-empty">Waiting for output…</div>
      <div v-for="(line, i) in tool.output ?? []" :key="i">{{ line }}</div>
    </div>
  </div>
</template>

<style scoped>
.media-tool {
  display: inline-flex;
  flex-direction: column;
  width: 176px;
  max-width: 100%;
  margin: 0 8px 0 0;
  vertical-align: top;
}
.media-title {
  color: var(--muted);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.4;
  margin: 0 0 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-video {
  display: block;
  width: 100%;
  height: 118px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  object-fit: contain;
}
.media-image-button {
  appearance: none;
  display: block;
  width: 100%;
  height: 118px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  cursor: zoom-in;
  overflow: hidden;
}
.media-image-button:hover {
  border-color: var(--blue);
}
.media-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.media-audio {
  display: block;
  width: 100%;
}
.media-tool.mob .media-image-button,
.media-tool.mob .media-video {
  height: 104px;
}
.media-tool.mob {
  width: min(46vw, 164px);
  margin: 0 7px 0 0;
}

.box {
  --tool-card-radius: 3px;
  --tool-head-radius: 3px;
  border: 1px solid var(--line);
  margin: 0;
  background: var(--bg);
  border-radius: var(--tool-card-radius);
}
.box.err {
  border-color: color-mix(in srgb, var(--err) 35%, var(--bg));
}
.bh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: var(--panel);
  cursor: pointer;
  font-size: var(--ui-font-size);
  border-radius: var(--tool-head-radius);
}
.box.open .bh {
  border-bottom: 1px solid var(--line);
  border-radius: var(--tool-head-radius) var(--tool-head-radius) 0 0;
}
.box.err .bh {
  background: color-mix(in srgb, var(--err) 6%, var(--bg));
}
.bh:hover {
  background: var(--panel2);
}
.box.err .bh:hover {
  background: color-mix(in srgb, var(--err) 11%, var(--bg));
}
.car { color: var(--faint); }
.gl {
  display: inline-flex;
  align-items: center;
  color: var(--dim);
  flex: none;
}
.a { color: var(--blue2); font-weight: 700; }
.p { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.rt {
  margin-left: auto;
  color: var(--muted);
  font-size: calc(var(--ui-font-size) - 3px);
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.chip {
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 5px;
  color: var(--dim);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.ok { color: var(--ok); font-weight: 700; }
.er { color: var(--err); font-weight: 700; }
.tm { color: var(--muted); }

/* running spinner — matches the FilePreview ring spinner */
@keyframes tc-spin { to { transform: rotate(360deg); } }
.spin {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 1.4px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: tc-spin 0.7s linear infinite;
  flex: none;
}
.bb {
  padding: 8px 11px;
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 2.5px);
  line-height: 1.7;
  font-family: var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
}
/* The command/summary, shown at the top of the expanded body (it's hidden from
   the header while open). Separated from the output by a dashed rule. */
.bb-summary {
  color: var(--ink);
  border-bottom: 1px dashed var(--line);
  padding-bottom: 6px;
  margin-bottom: 6px;
  word-break: break-all;
}
.bb-empty {
  color: var(--muted);
  font-style: italic;
}
/* Mobile bubble layout: no left gutter indent, softer corners (prototype .tool). */
.box.mob {
  --tool-card-radius: 9px;
  --tool-head-radius: 8px;
  margin: 0;
}

/* Consecutive non-media tool cards render as one stacked panel. The parent
   computes the run position; this component owns the exact card/header shape. */
.box.stack-middle,
.box.stack-last {
  margin-top: -1px;
}
.box.stacked {
  box-shadow: none;
}
.box.stack-first {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.box.stack-middle {
  border-radius: 0;
}
.box.stack-last {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.box.stack-first .bh {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.box.stack-middle .bh {
  border-radius: 0;
}
.box.stack-last .bh,
.box.stack-last.open .bh {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.box.stacked:hover {
  transform: none;
  box-shadow: none;
}

/* NOTE: Modern-theme tool-card styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .box` rules here did NOT win the cascade
   (cards stayed square, no shadow), so they were moved to the global sheet. */
</style>
