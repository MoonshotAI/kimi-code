<!-- apps/kimi-web/src/components/ToolCall.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import type { ToolCall } from '../types';
import { toolLabel, toolGlyph, toolChip, toolSummary } from '../lib/toolMeta';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    /** Mobile bubble layout: drop the 33px gutter indent + use a softer radius. */
    mobile?: boolean;
  }>(),
  { mobile: false },
);
const hasOutput = () => !!props.tool.output && props.tool.output.length > 0;
const open = ref(props.tool.defaultExpanded === true && hasOutput());

function toggle() {
  if (hasOutput()) open.value = !open.value;
}

const mark = () => (props.tool.status === 'error' ? '✕' : '✓');

const label = () => toolLabel(props.tool.name);
const glyph = () => toolGlyph(props.tool.name);
const summary = () => toolSummary(props.tool.name, props.tool.arg);
const chip = () => toolChip({
  name: props.tool.name,
  arg: props.tool.arg,
  output: props.tool.output,
  timing: props.tool.timing,
  status: props.tool.status,
});

const isError = () => props.tool.status === 'error';
</script>

<template>
  <div class="box" :class="{ open, err: isError(), mob: mobile }">
    <div class="bh" @click="toggle">
      <span class="car">{{ open ? '▾' : '▸' }}</span>
      <!-- inline SVG glyph -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span class="gl" v-html="glyph()" aria-hidden="true" />
      <span class="a">{{ label() }}</span>
      <span class="p" :title="summary()">· {{ summary() }}</span>
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
      <div v-for="(line, i) in tool.output" :key="i">{{ line }}</div>
    </div>
  </div>
</template>

<style scoped>
.box {
  border: 1px solid var(--line);
  margin: 7px 0 7px 33px;
  background: #fff;
  border-radius: 3px;
}
.box.err {
  border-color: #f5c6c6;
}
.bh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: var(--panel);
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
}
.box.open .bh {
  border-bottom: 1px solid var(--line);
  border-radius: 3px 3px 0 0;
}
.box.err .bh {
  background: #fff5f5;
}
.bh:hover {
  background: var(--panel2);
}
.box.err .bh:hover {
  background: #ffecec;
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
  font-size: 11px;
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
  font-size: 10.5px;
}
.ok { color: var(--ok); font-weight: 700; }
.er { color: var(--err); font-weight: 700; }
.tm { color: var(--muted); }

/* running spinner — matches the FilePreview/FileTree ring spinner */
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
  font-size: 11.5px;
  line-height: 1.7;
  font-family: var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Mobile bubble layout: no left gutter indent, softer corners (prototype .tool). */
.box.mob {
  margin: 8px 0 0 0;
  border-radius: 9px;
}
.box.mob .bh { border-radius: 8px; }
.box.mob.open .bh { border-radius: 8px 8px 0 0; }

/* ===================== Modern theme ===================== */
/* Tool cards: smooth fade/slide entrance, soft shadow + hover lift (float), an
   animated checkmark on completion, and a subtle staggered reveal of output
   lines. Reduced-motion is neutralized by the global guard in style.css. */
:global(html[data-theme="modern"]) .box {
  background: #fff;
  border-radius: 12px;
  box-shadow: var(--shc);
  animation: kimi-card-in 0.26s ease-out both;
  transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}
:global(html[data-theme="modern"]) .box:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(20, 23, 28, 0.10);
}
:global(html[data-theme="modern"]) .box .bh { border-radius: 12px; }
:global(html[data-theme="modern"]) .box.open .bh { border-radius: 12px 12px 0 0; }
/* Completion checkmark scales/fades in. */
:global(html[data-theme="modern"]) .box .ok,
:global(html[data-theme="modern"]) .box .er {
  display: inline-block;
  animation: kimi-check-in 0.2s ease-out both;
}
/* Output lines reveal with a subtle stagger (first 6 lines). */
:global(html[data-theme="modern"]) .box.open .bb > div {
  animation: kimi-line-in 0.2s ease-out both;
}
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(1) { animation-delay: 0ms; }
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(2) { animation-delay: 30ms; }
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(3) { animation-delay: 60ms; }
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(4) { animation-delay: 90ms; }
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(5) { animation-delay: 120ms; }
:global(html[data-theme="modern"]) .box.open .bb > div:nth-child(6) { animation-delay: 150ms; }
</style>
