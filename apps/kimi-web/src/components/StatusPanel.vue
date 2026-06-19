<!-- apps/kimi-web/src/components/StatusPanel.vue -->
<!-- /status overlay — renders the CURRENT session status from existing client -->
<!-- state (no daemon call). Light only, monospace, Kimi blue, no emoji. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../types';
import type { ThinkingLevel } from '../api/types';

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

const pct = computed(() =>
  props.status.ctxMax > 0 ? Math.round((props.status.ctxUsed / props.status.ctxMax) * 100) : 0,
);

const contextValue = computed(() =>
  props.status.ctxMax > 0
    ? t('status.statusContextValue', {
        used: props.status.ctxUsed.toLocaleString(),
        max: props.status.ctxMax.toLocaleString(),
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
  if (p === 'yolo') return 'var(--err)';
  if (p === 'auto') return 'var(--warn)';
  return 'var(--ink)';
});

const planText = computed(() => (props.planMode ? t('status.planOn') : t('status.planOff')));
const swarmText = computed(() => (props.swarmMode ? t('status.swarmOn') : t('status.swarmOff')));

const showCost = computed(() => typeof props.costUsd === 'number' && props.costUsd > 0);
const costText = computed(() =>
  showCost.value ? `$${(props.costUsd as number).toFixed(4)}` : t('status.statusNone'),
);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="t('status.statusPanelTitle')">
      <div class="dh">
        <span class="dtitle">{{ t('status.statusPanelTitle') }}</span>
        <button class="close-btn" :title="t('status.statusPanelClose')" @click="emit('close')">✕</button>
      </div>

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
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dialog {
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 420px;
  max-width: calc(100vw - 32px);
  height: 320px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.14);
}

.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  gap: 8px;
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  letter-spacing: 0.02em;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: var(--ui-font-size);
  padding: 2px 4px;
  line-height: 1;
}
.close-btn:hover { color: var(--ink); }

.rows {
  margin: 0;
  padding: 6px 0;
  flex: 1;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 16px;
  font-size: calc(var(--ui-font-size) - 1.5px);
}
.row dt {
  width: 96px;
  flex: none;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.row dd {
  margin: 0;
  color: var(--ink);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.row dd.plan-on { color: var(--blue); }
.row dd.swarm-on { color: var(--blue); }

.ctx-text { flex: none; }
.bar {
  width: 80px;
  height: 5px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
  flex: none;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--blue);
}

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: auto;
    max-height: calc(100dvh - 24px);
  }
  .rows {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .row {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
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
