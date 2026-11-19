<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, IconButton } from '@moonshot-ai/app-ui';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { SessionContextItemPart } from '@moonshot-ai/app-core/api';
import JsonTree from './JsonTree.vue';
import { contextPartText } from './contextCopy';

const props = defineProps<{ part: SessionContextItemPart; role?: string }>();
const { t } = useI18n();
const copyText = computed(() => contextPartText(props.part));
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
let resetTimer: ReturnType<typeof setTimeout> | undefined;

function asObj(val: unknown): Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

const toolDefinition = computed(() => {
  if (props.part.kind !== 'definition') return null;
  const tool = asObj(props.part.data);
  const schema = asObj(tool['parameters']);
  const properties = asObj(schema['properties']);
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].map(String) : []);
  const parameters = Object.entries(properties).map(([name, value]) => {
    const prop = asObj(value);
    const kind = Array.isArray(prop['type']) ? prop['type'].join(' | ') : typeof prop['type'] === 'string' ? prop['type'] : Array.isArray(prop['enum']) ? 'enum' : 'unknown';
    return {
      name,
      type: kind,
      required: required.has(name),
      description: typeof prop['description'] === 'string' ? prop['description'] : '',
      extra: Object.fromEntries(Object.entries(prop).filter(([k]) => !['type', 'description'].includes(k))),
    };
  });
  const extraSchema = Object.fromEntries(Object.entries(schema).filter(([k]) => !['type', 'properties', 'required'].includes(k)));
  return {
    name: props.part.name || (typeof tool['name'] === 'string' ? tool['name'] : ''),
    description: typeof tool['description'] === 'string' ? tool['description'] : '',
    parameters,
    extraSchema,
  };
});

const copyLabel = computed(() =>
  t(copyState.value === 'copied'
    ? 'inspector.copied'
    : copyState.value === 'failed'
      ? 'inspector.copyFailed'
      : 'inspector.copyPart'),
);

async function copy(): Promise<void> {
  if (!copyText.value) return;
  copyState.value = await copyTextToClipboard(copyText.value) ? 'copied' : 'failed';
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => (copyState.value = 'idle'), 1500);
}

onBeforeUnmount(() => clearTimeout(resetTimer));
</script>

<template>
  <section class="context-part" :data-kind="part.kind">
    <div class="part-copy">
      <IconButton v-if="copyText" size="sm" :label="copyLabel" :tooltip="copyLabel" @click.stop="copy">
        <Icon :name="copyState === 'copied' ? 'check' : copyState === 'failed' ? 'close' : 'copy'" size="sm" />
      </IconButton>
    </div>
    <div v-if="part.kind === 'think'" class="part-box">
      <div class="part-head"><span>{{ t('inspector.thinking') }}</span></div>
      <div class="prose">{{ part.text }}</div>
    </div>
    <div v-else-if="part.kind === 'text'" class="part-box">
      <div class="part-head">
        <span>{{ part.name || t(role === 'system' ? 'inspector.promptText' : 'inspector.messageText') }}</span>
        <span v-if="role === 'system' && part.text" class="part-note">{{ t('inspector.characters', { n: part.text.length.toLocaleString() }) }}</span>
      </div>
      <div class="prose">{{ part.text }}</div>
    </div>
    <div v-else-if="part.kind === 'definition' && toolDefinition" class="part-box">
      <div class="part-head">
        <span>{{ t('inspector.role.definition') }}</span>
        <code v-if="toolDefinition.name">{{ toolDefinition.name }}</code>
      </div>
      <div v-if="toolDefinition.description" class="prose">{{ toolDefinition.description }}</div>
      <div v-if="toolDefinition.parameters.length" class="definition-section">
        <div class="section-title">{{ t('inspector.toolParameters') }} · {{ toolDefinition.parameters.length }}</div>
        <div v-for="param in toolDefinition.parameters" :key="param.name" class="parameter-row">
          <div class="parameter-head"><code>{{ param.name }}</code><span class="parameter-type">{{ param.type }}</span><Badge :variant="param.required ? 'info' : 'neutral'">{{ t(param.required ? 'inspector.requiredParameter' : 'inspector.optionalParameter') }}</Badge></div>
          <div v-if="param.description" class="parameter-description">{{ param.description }}</div>
          <JsonTree v-if="Object.keys(param.extra).length" :value="param.extra" root />
        </div>
      </div>
      <div v-if="Object.keys(toolDefinition.extraSchema).length" class="definition-section">
        <div class="section-title">{{ t('inspector.schemaConstraints') }}</div>
        <div class="part-tree"><JsonTree :value="toolDefinition.extraSchema" root /></div>
      </div>
    </div>
    <div v-else-if="part.kind === 'function'" class="part-box">
      <div class="part-head"><span>{{ t('inspector.toolCall') }}</span><code>{{ part.name || '—' }}</code></div>
      <div class="part-tree"><JsonTree :value="part.data" root /></div>
    </div>
    <div v-else-if="part.kind === 'media'" class="part-box">
      <div class="part-head"><span>{{ t('inspector.attachmentData') }}</span><code>{{ part.name }}</code><span class="part-note">{{ t('inspector.mediaHint') }}</span></div>
      <div class="part-tree"><JsonTree :value="part.data" root /></div>
    </div>
  </section>
</template>

<style scoped>
.context-part { position: relative; min-width: 0; }
.part-copy { position: absolute; z-index: 1; top: 0; right: var(--space-1); display: flex; align-items: center; height: var(--space-6); opacity: .55; }
.context-part:hover > .part-copy, .part-copy:focus-within { opacity: 1; }
.part-box { border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-sm); overflow: hidden; background: var(--color-bg); }
.part-head { display: flex; align-items: center; gap: var(--space-2); min-height: var(--space-6); padding: var(--space-1) var(--space-8) var(--space-1) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); color: var(--color-text-muted); font-size: var(--text-xs); }
.part-head code { color: var(--color-text); font-family: var(--font-mono); }
.part-note { margin-left: auto; color: var(--color-text-faint); }
.prose { padding: var(--space-3); color: var(--color-text); font: var(--text-xs) var(--font-ui); line-height: var(--leading-relaxed); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.part-tree { padding: var(--space-2); user-select: text; }
.definition-section { border-top: var(--p-hairline) solid var(--color-line); }
.section-title { padding: var(--space-1) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); color: var(--color-text-muted); font-size: var(--text-xs); }
.parameter-row { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); user-select: text; }
.parameter-row:last-child { border-bottom: 0; }
.parameter-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.parameter-head code { color: var(--color-text); font-family: var(--font-mono); }
.parameter-type { color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
.parameter-description { color: var(--color-text-muted); font-size: var(--text-xs); line-height: var(--leading-relaxed); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
