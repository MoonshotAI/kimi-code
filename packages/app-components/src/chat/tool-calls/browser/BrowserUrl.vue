<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ url: string }>();
const { t } = useI18n();
const LONG = 32;
const HEAD = 16;
const expanded = ref<ReadonlySet<number>>(new Set());

function decode(value: string, whole: boolean): string {
  try {
    return whole ? decodeURI(value) : decodeURIComponent(value);
  } catch {
    return value;
  }
}

const parts = computed(() => {
  let parsed: URL;
  try {
    parsed = new URL(props.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const query = parsed.search.slice(1);
  return {
    scheme: `${parsed.protocol}//`,
    host: parsed.username || parsed.password ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@${parsed.host}` : parsed.host,
    path: decode(parsed.pathname, true),
    params: query === '' ? [] : query.split('&').map((pair) => {
      const at = pair.indexOf('=');
      const key = decode(at === -1 ? pair : pair.slice(0, at), false);
      const value = at === -1 ? undefined : decode(pair.slice(at + 1), false);
      return { key, value, long: value !== undefined && value.length > LONG };
    }),
    hash: decode(parsed.hash, true),
  };
});

function toggle(index: number): void {
  const next = new Set(expanded.value);
  if (!next.delete(index)) next.add(index);
  expanded.value = next;
}
</script>

<template>
  <span v-if="parts === undefined" class="burl-plain">{{ url }}</span>
  <span v-else class="burl">
    <span class="burl-origin"><span class="burl-scheme">{{ parts.scheme }}</span><span class="burl-host">{{ parts.host }}</span><span class="burl-path">{{ parts.path }}</span></span>
    <span v-for="(param, index) in parts.params" :key="index" class="burl-param">
      <span class="burl-key">{{ param.key }}</span><template v-if="param.value !== undefined">=<span class="burl-value">{{ param.long && !expanded.has(index) ? `${param.value.slice(0, HEAD)}…` : param.value }}</span></template>
      <button v-if="param.long" class="burl-toggle" type="button" :aria-expanded="expanded.has(index)" @click.stop="toggle(index)">
        {{ t(expanded.has(index) ? 'tools.browser.detail.urlCollapse' : 'tools.browser.detail.urlExpand') }}
      </button>
    </span>
    <span v-if="parts.hash" class="burl-hash">{{ parts.hash }}</span>
  </span>
</template>

<style scoped>
.burl,
.burl-plain {
  min-width: 0;
  color: var(--color-text);
  text-autospace: no-autospace;
}
.burl-plain {
  word-break: break-all;
}
.burl {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
}
.burl-origin {
  min-width: 0;
  word-break: break-all;
}
.burl-scheme {
  color: var(--color-text-faint);
}
.burl-host {
  font-weight: var(--weight-medium);
}
.burl-path,
.burl-hash {
  color: var(--color-text-muted);
  word-break: break-all;
}
.burl-param {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  max-width: 100%;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-fill-2);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.burl-key {
  color: var(--color-text);
}
.burl-value {
  min-width: 0;
  word-break: break-all;
}
.burl-toggle {
  margin-left: var(--space-1);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
}
.burl-toggle:hover {
  color: var(--color-text);
}
.burl-toggle:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
