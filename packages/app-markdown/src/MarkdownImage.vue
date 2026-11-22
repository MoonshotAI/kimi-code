<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { ImageNode, type ImageNodeProps } from 'markstream-vue';
import { OpenMarkdownImageKey } from '@moonshot-ai/app-core/contracts';
import { MarkdownImageSizesKey } from './lib/imageSizes';

const props = defineProps<Omit<ImageNodeProps, 'node'> & { node?: ImageNodeProps['node'] }>();

const openImage = inject(OpenMarkdownImageKey, undefined);
const sizes = inject(MarkdownImageSizesKey, undefined);
const nodeRef = ref<ComponentPublicInstance | null>(null);
const loadedSrc = ref<string | null>(null);

const src = computed(() => props.node?.src ?? '');
const info = computed(() => (sizes && src.value ? sizes.lookup(src.value) : undefined));
const sizeStyle = computed(() => {
  const size = info.value?.size;
  if (!size) return undefined;
  return { '--md-image-width': `${size[0]}px`, '--md-image-ratio': `${size[0]} / ${size[1]}` };
});
const pending = computed(() => sizes !== undefined && !info.value?.size && (info.value?.pending === true || loadedSrc.value !== src.value));

function imageElement(): HTMLImageElement | null {
  const root = nodeRef.value?.$el;
  return root instanceof Element ? root.querySelector('img') : null;
}

function remember(img: HTMLImageElement | null): void {
  if (!img || !src.value || img.getAttribute('src') !== src.value || !img.complete || img.naturalWidth === 0) return;
  loadedSrc.value = src.value;
  sizes?.remember(src.value, img.naturalWidth, img.naturalHeight);
}

onMounted(() => remember(imageElement()));
watch(src, () => {
  void nextTick(() => remember(imageElement()));
});

function imageAlt(): string | undefined {
  return props.node?.alt || props.node?.title || undefined;
}

function onLoad() {
  remember(imageElement());
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
  <ImageNode
    v-if="node"
    ref="nodeRef"
    v-bind="{ node, fallbackSrc, lazy, usePlaceholder }"
    :class="{ 'md-image-sized': sizeStyle !== undefined, 'md-image-pending': pending }"
    :style="sizeStyle"
    :data-caption="node.title || undefined"
    @load="onLoad"
    @click="onClick"
    @keydown="onKeydown"
  />
  <image v-else />
</template>
