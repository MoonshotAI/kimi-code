<!-- apps/kimi-web/src/components/chat/StreamingBlocks.vue -->
<!--
  Renders the live (still-streaming) text/thinking blocks of the active
  assistant message. This is the ONLY component that re-renders on each
  `assistantDelta`: it subscribes to the fine-grained streaming store, so the
  rest of the app (App, sidebar, the turn list) does not move on every token.

  Mounted by ChatPane only for the turn that is currently streaming; unmounts
  when the turn settles (the committed content in `messagesBySession` takes
  over).
-->
<script setup lang="ts">
import { computed } from 'vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import { streamingBySession } from '../../composables/client/streamingStore';
import type { FilePreviewRequest } from '../../types';

const props = withDefaults(
  defineProps<{
    sessionId: string;
    turnId: string;
    mobile?: boolean;
  }>(),
  { mobile: false },
);

const emit = defineEmits<{
  openFile: [target: FilePreviewRequest];
  openThinking: [target: { turnId: string; blockIndex: number; live?: boolean }];
}>();

// Subscribe to this session's live blocks. Only this computed (and therefore
// only this component) is dirtied when a delta appends to the store.
const blocks = computed(() => streamingBySession[props.sessionId]?.blocks ?? []);
</script>

<template>
  <template v-for="blk in blocks" :key="`stream-${blk.kind}-${blk.contentIndex}`">
    <ThinkingBlock
      v-if="blk.kind === 'thinking'"
      :text="blk.text"
      :mobile="mobile"
      :streaming="true"
      @open="emit('openThinking', { turnId, blockIndex: blk.contentIndex, live: true })"
    />
    <div v-else-if="blk.kind === 'text' && blk.text" class="msg">
      <Markdown :text="blk.text" :streaming="true" :open-file="(target) => emit('openFile', target)" />
    </div>
  </template>
</template>
