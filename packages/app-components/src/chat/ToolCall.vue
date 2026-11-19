<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import { NotifyUserEnabledKey } from '@moonshot-ai/app-client/contracts';
import type { OpenMediaRequest, ToolCall } from '@moonshot-ai/app-core/client/types';
import { resolveToolRenderer } from './tool-calls/toolRegistry';
import NotifyUserTool from './tool-calls/NotifyUserTool.vue';
import PlanTool from './tool-calls/PlanTool.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null;
    resolveImage?: (src: string) => Promise<string>;
  }>(),
  { mobile: false, resolveFilePath: undefined, resolveImage: undefined },
);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  detach: [toolCallId: string];
}>();

const Renderer = computed(() => resolveToolRenderer(props.tool, { notifyUserEnabled: notifyUserEnabled.value }));
const forwardsResolver = computed(() => Renderer.value === NotifyUserTool || Renderer.value === PlanTool);
const rendererRef = ref<ComponentPublicInstance | null>(null);
const notifyUserEnabled = inject(NotifyUserEnabledKey, computed(() => true));
const historyState = inject(HistoryStateKey, undefined);
const scrollKey = computed(() => `tool:${props.tool.id}:scroll`);

function scrollSurfaces(): HTMLElement[] {
  const el: unknown = rendererRef.value?.$el;
  return el instanceof HTMLElement ? Array.from(el.querySelectorAll<HTMLElement>('.op, .hl-code, .tp-body.scroll')) : [];
}

onMounted(() => {
  const saved = historyState?.get(scrollKey.value) as [number, number][] | undefined;
  if (!saved) return;
  void nextTick(() => {
    scrollSurfaces().forEach((el, index) => {
      const position = saved[index];
      if (!position) return;
      [el.scrollTop, el.scrollLeft] = position;
    });
  });
});

onBeforeUnmount(() => {
  if (!historyState) return;
  const surfaces = scrollSurfaces();
  if (surfaces.length) historyState.set(scrollKey.value, surfaces.map(el => [el.scrollTop, el.scrollLeft]));
});
</script>

<template>
  <component
    ref="rendererRef"
    :is="Renderer"
    :tool="tool"
    :data-scroll-anchor-id="tool.id"
    :mobile="mobile"
    :resolve-file-path="forwardsResolver ? resolveFilePath : undefined"
    :resolve-image="forwardsResolver ? resolveImage : undefined"
    @open-media="emit('openMedia', $event)"
    @detach="emit('detach', $event)"
  />
</template>
