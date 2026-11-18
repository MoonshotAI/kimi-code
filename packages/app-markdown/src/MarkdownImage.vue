<script setup lang="ts">
import { inject } from 'vue';
import { ImageNode, type ImageNodeProps } from 'markstream-vue';
import { OpenMarkdownImageKey } from '@moonshot-ai/app-core/contracts';

const props = defineProps<Omit<ImageNodeProps, 'node'> & { node?: ImageNodeProps['node'] }>();

const openImage = inject(OpenMarkdownImageKey, undefined);

function imageAlt(): string | undefined {
  return props.node?.alt || props.node?.title || undefined;
}

function onClick([event, src]: [event: Event, src: string]) {
  if (!openImage) return;
  openImage({
    src,
    alt: imageAlt(),
    originImg: event.target instanceof HTMLImageElement ? event.target : null,
  });
}

function onKeydown(event: KeyboardEvent) {
  if (!openImage || (event.key !== 'Enter' && event.key !== ' ')) return;
  const img = event.target instanceof HTMLImageElement ? event.target : null;
  if (!img) return;
  event.preventDefault();
  openImage({ src: img.currentSrc || img.src, alt: imageAlt(), originImg: img });
}
</script>

<template>
  <ImageNode v-if="node" v-bind="{ node, fallbackSrc, lazy, usePlaceholder }" :data-caption="node.title || undefined" @click="onClick" @keydown="onKeydown" />
  <image v-else />
</template>
