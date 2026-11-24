<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Tooltip } from '@moonshot-ai/app-ui';
import type { SessionContextGroup, SessionContextSummary } from '@moonshot-ai/app-core/api';
import { formatTokenEstimate, formatTokens, formatTokenShare } from '@moonshot-ai/app-core/lib';

const props = withDefaults(defineProps<{
  snapshot: SessionContextSummary | null;
  ctxUsed?: number;
  ctxMax?: number;
  size?: 'compact' | 'expanded';
  selectedRoles?: readonly string[];
}>(), {
  size: 'compact',
});

const emit = defineEmits<{
  toggle: [role: string];
}>();

const { t, te } = useI18n();

const selectable = computed(() => props.selectedRoles !== undefined);
const filtering = computed(() => (props.selectedRoles?.length ?? 0) > 0);
const usedTokens = computed(() => props.snapshot?.tokens.used ?? props.ctxUsed ?? 0);
const maxTokens = computed(() => props.snapshot?.tokens.max ?? props.ctxMax ?? 0);

const usage = computed(() => {
  if (!props.snapshot && props.ctxUsed === undefined) return null;
  const used = formatTokens(usedTokens.value);
  if (maxTokens.value <= 0) return { headline: `${t('inspector.usedLabel')} ${used}`, total: '' };
  const pct = Math.min(100, Math.ceil((usedTokens.value / maxTokens.value) * 100));
  return {
    headline: t('inspector.usedPercent', { pct }),
    total: `${used} / ${formatTokens(maxTokens.value)}`,
  };
});

function groupCountLabel(group: SessionContextGroup): string {
  const countKey = `inspector.compositionCount.${group.role}`;
  return t(te(countKey) ? countKey : 'inspector.compositionCount.unknown', {
    n: group.count.toLocaleString(),
  });
}

const rows = computed(() => {
  const groups = (props.snapshot?.groups ?? []).filter((group) => group.tokens > 0);
  const scale = maxTokens.value > 0
    ? maxTokens.value
    : groups.reduce((sum, group) => sum + group.tokens, 0);
  return groups.map((group) => {
    const name = t(`inspector.role.${group.role}`, group.role);
    const tokens = formatTokenEstimate(group.tokens);
    return {
      role: group.role,
      name,
      count: groupCountLabel(group),
      tokens,
      share: maxTokens.value > 0 ? formatTokenShare(group.tokens, maxTokens.value) : '',
      width: `${(group.tokens / scale) * 100}%`,
      label: `${name} · ${tokens}`,
      selected: props.selectedRoles?.includes(group.role) ?? false,
    };
  });
});
</script>

<template>
  <div class="ctx-composition" :class="`is-${size}`">
    <div v-if="usage" class="ctx-usage">
      <span class="ctx-usage-headline">{{ usage.headline }}</span>
      <span class="ctx-usage-trailing">
        <span v-if="usage.total" class="ctx-usage-total">{{ usage.total }}</span>
        <slot name="headline-extra" />
      </span>
    </div>
    <template v-if="snapshot">
      <div class="ctx-composition-bar" :aria-label="t('inspector.composition')">
        <Tooltip v-for="row in rows" :key="row.role" :text="row.label">
          <button
            v-if="selectable"
            type="button"
            class="ctx-composition-seg"
            :class="{ dimmed: filtering && !row.selected }"
            :data-context-role="row.role"
            :style="{ width: row.width }"
            :aria-label="row.label"
            :aria-pressed="row.selected"
            @click="emit('toggle', row.role)"
          />
          <span v-else class="ctx-composition-seg" :data-context-role="row.role" :style="{ width: row.width }" />
        </Tooltip>
        <span class="ctx-composition-free" />
      </div>
      <div v-if="rows.length > 0" class="ctx-role-list">
        <template v-if="selectable">
          <Tooltip v-for="row in rows" :key="row.role" :text="row.count">
            <button
              type="button"
              class="ctx-role-row ctx-role-toggle"
              :class="{ selected: row.selected, muted: filtering && !row.selected }"
              :data-context-role="row.role"
              :aria-pressed="row.selected"
              @click="emit('toggle', row.role)"
            >
              <span class="ctx-role-marker" />
              <span class="ctx-role-name">{{ row.name }}</span>
              <span class="ctx-role-tokens">{{ row.tokens }}</span>
              <span v-if="row.share" class="ctx-role-share">{{ row.share }}</span>
            </button>
          </Tooltip>
        </template>
        <template v-else>
          <div v-for="row in rows" :key="row.role" class="ctx-role-row" :data-context-role="row.role">
            <span class="ctx-role-marker" />
            <Tooltip :text="row.count">
              <span class="ctx-role-name" tabindex="0">{{ row.name }}</span>
            </Tooltip>
            <span class="ctx-role-tokens">{{ row.tokens }}</span>
            <span v-if="row.share" class="ctx-role-share">{{ row.share }}</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-composition {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-family: var(--font-ui);
}

.ctx-usage {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ctx-usage-headline {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ctx-usage-trailing {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.ctx-usage-total {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.ctx-composition-bar {
  display: flex;
  gap: 1px;
  height: var(--space-1-5);
  overflow: hidden;
}
.ctx-composition-seg,
.ctx-composition-free {
  display: block;
  height: 100%;
  border-radius: 1px;
}
.ctx-composition-seg {
  flex: none;
  min-width: var(--space-1);
  padding: 0;
  border: 0;
  background: var(--context-color, var(--color-text-faint));
}
.ctx-composition-free {
  flex: 1;
  min-width: 0;
  background: var(--color-fill-2);
}
.is-expanded .ctx-composition-bar {
  height: var(--space-3);
}
.is-expanded .ctx-composition-seg,
.is-expanded .ctx-composition-free {
  border-radius: var(--radius-context-segment);
}
button.ctx-composition-seg {
  cursor: pointer;
}
button.ctx-composition-seg:hover {
  opacity: 0.8;
}
.ctx-composition-seg.dimmed {
  opacity: 0.25;
}

.ctx-role-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.ctx-role-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-xs);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ctx-role-toggle {
  width: calc(100% + var(--space-2));
  margin: 0 calc(-1 * var(--space-1));
  padding: var(--space-05) var(--space-1);
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.ctx-role-toggle:hover {
  background: var(--color-hover);
}
.ctx-role-toggle.selected {
  background: var(--color-selected);
}
.ctx-role-toggle.muted {
  opacity: 0.4;
}
.ctx-role-toggle.muted .ctx-role-marker {
  background: transparent;
  box-shadow: inset 0 0 0 var(--p-hairline) var(--context-color, var(--color-text-faint));
}
.ctx-role-marker {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-context-segment);
  background: var(--context-color, var(--color-text-faint));
  flex: none;
}
.ctx-role-name {
  color: var(--color-text);
  cursor: default;
  border-radius: var(--radius-xs);
}
.ctx-role-toggle .ctx-role-name {
  cursor: inherit;
}
.ctx-role-name:focus-visible,
.ctx-role-toggle:focus-visible,
button.ctx-composition-seg:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ctx-role-tokens {
  margin-left: auto;
  color: var(--color-text-muted);
}
.ctx-role-share {
  width: 40px;
  flex: none;
  text-align: right;
  color: var(--color-text);
}
</style>
