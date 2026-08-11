<!-- apps/web/src/components/chat/ToolCall.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { FilePreviewRequest, OpenMediaRequest, ToolCall } from '../../types';
import { resolveToolRenderer } from './tool-calls/toolRegistry';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
  }>(),
  { mobile: false },
);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  openFile: [target: FilePreviewRequest];
  openAgent: [toolCallId: string];
}>();

const Renderer = computed(() => resolveToolRenderer(props.tool));
</script>

<template>
  <component
    :is="Renderer"
    :tool="tool"
    :mobile="mobile"
    @open-media="emit('openMedia', $event)"
    @open-file="emit('openFile', $event)"
    @open-agent="emit('openAgent', $event)"
  />
</template>
