<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';
import { str, urlHost } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const { t, status, args, argText, hasOutput } = useToolCard(props);
const url = computed(() => str(args.value?.url) ?? str(args.value?.uri) ?? '');
const host = computed(() => (url.value ? urlHost(url.value) : ''));
const canExpand = computed(() => hasOutput.value);
const { open } = useToolCardExpansion(props, canExpand);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="globe" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.web_fetch') }}</span>
    <span v-if="host" class="tl-dim">{{ host }}</span>
    <span v-else-if="argText" class="tl-dim">{{ argText }}</span>
    <template #body>
      <ToolPanel :title="host" :meta="url" :copy-text="url" scroll>
        <OutputPanel :lines="tool.output" :empty-text="t('tools.output.waiting')" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

