<!-- apps/kimi-web/src/components/chat/StatusPanel.vue -->
<!-- /status overlay — renders the CURRENT session status from existing client -->
<!-- state (no daemon call). Built on the design-system Dialog primitive. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../../types';
import type { ThinkingLevel } from '../../api/types';
import { formatTokens } from '../../lib/formatTokens';
import Dialog from '../ui/Dialog.vue';

const { t } = useI18n();

const props = defineProps<{
  status: ConversationStatus;
  thinking: ThinkingLevel;
  planMode: boolean;
  swarmMode?: boolean;
  /** Cumulative session cost in USD, when known (>= 0). */
  costUsd?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted. Dialog emits `close` on Esc / overlay / close
// button, which we forward to the parent.
const open = ref(true);

// ceil (not round) so sub-0.5% usage still renders a visible bar sliver;
// clamped to 0–100 — ctxUsed can momentarily exceed ctxMax (estimates).
const pct = computed(() => {
  if (props.status.ctxMax <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((props.status.ctxUsed / props.status.ctxMax) * 100)));
});

const contextValue = computed(() =>
  props.status.ctxMax > 0
    ? t('status.statusContextValue', {
        used: formatTokens(props.status.ctxUsed),
        max: formatTokens(props.status.ctxMax),
        pct: pct.value,
      })
    : t('status.statusNone'),
);

function permLabel(p: PermissionMode): string {
  if (p === 'yolo') return t('status.permissionYolo');
  if (p === 'auto') return t('status.permissionAuto');
  return t('status.permissionManual');
}

const permColor = computed(() => {
  const p = props.status.permission;
  if (p === 'yolo') return 'var(--color-danger)';
  if (p === 'auto') return 'var(--color-warning)';
  return 'var(--color-text)';
});

const planText = computed(() => (props.planMode ? t('status.planOn') : t('status.planOff')));
const swarmText = computed(() => (props.swarmMode ? t('status.swarmOn') : t('status.swarmOff')));

const showCost = computed(() => typeof props.costUsd === 'number' && props.costUsd > 0);
const costText = computed(() =>
  showCost.value ? `$${(props.costUsd as number).toFixed(4)}` : t('status.statusNone'),
);
</script>

<template>
  <Dialog v-model:open="open" :title="t('status.statusPanelTitle')" @close="emit('close')">
    <dl class="rows">
      <div class="row">
        <dt>{{ t('status.statusModel') }}</dt>
        <dd>{{ status.model }}</dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusThinking') }}</dt>
        <dd>{{ thinking }}</dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusPermission') }}</dt>
        <dd :style="{ color: permColor }">{{ permLabel(status.permission) }}</dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusPlanMode') }}</dt>
        <dd :class="{ 'plan-on': planMode }">{{ planText }}</dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusSwarmMode') }}</dt>
        <dd :class="{ 'swarm-on': swarmMode }">{{ swarmText }}</dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusContext') }}</dt>
        <dd>
          <span class="ctx-text">{{ contextValue }}</span>
          <span v-if="status.ctxMax > 0" class="bar"><i :style="{ width: pct + '%' }"></i></span>
        </dd>
      </div>
      <div class="row">
        <dt>{{ t('status.statusCost') }}</dt>
        <dd>{{ costText }}</dd>
      </div>
    </dl>
  </Dialog>
</template>

<style scoped>
.rows {
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  font-size: var(--text-base);
}
.row dt {
  width: 96px;
  flex: none;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--text-xs);
}
.row dd {
  margin: 0;
  color: var(--color-text);
  font-weight: var(--weight-medium);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.row dd.plan-on { color: var(--color-accent); }
.row dd.swarm-on { color: var(--color-accent); }

.ctx-text { flex: none; }
.bar {
  width: 80px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
  flex: none;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--color-accent);
}

@media (max-width: 640px) {
  .rows {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-1);
    min-height: 48px;
  }
  .row dt {
    width: auto;
  }
  .row dd {
    max-width: 100%;
    flex-wrap: wrap;
  }
}
</style>
