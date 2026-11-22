<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon } from '@moonshot-ai/app-ui';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';
import WorktreeOutput from './WorktreeOutput.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  title: string;
  body: string;
  output?: string;
  busy?: boolean;
  label?: string;
}>(), {
  output: '',
  busy: false,
  label: undefined,
});

const emit = defineEmits<{
  retry: [];
}>();

const { t } = useI18n();
const popover = ref<{ el: HTMLElement | null } | null>(null);
const { open, menuStyle, toggleAnchored, close } = useAnchoredMenu(popover);
const hasOutput = computed(() => props.output.trim().length > 0);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | undefined;

function setPopover(element: unknown): void {
  popover.value = element instanceof HTMLElement ? { el: element } : null;
}

function toggle(event: MouseEvent): void {
  void toggleAnchored(event, 'right');
}

async function copyOutput(): Promise<void> {
  const ok = await copyTextToClipboard(props.output);
  copyState.value = ok ? 'copied' : 'failed';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyState.value = 'idle';
  }, 1500);
}

const copyLabel = computed(() => {
  if (copyState.value === 'copied') return t('worktreeSession.outputCopied');
  if (copyState.value === 'failed') return t('worktreeSession.copyFailed');
  return t('worktreeSession.copyOutput');
});

onBeforeUnmount(() => clearTimeout(copyTimer));

defineExpose({ close });
</script>

<template>
  <button
    type="button"
    v-bind="$attrs"
    class="sip-trigger"
    :class="{ open }"
    :aria-label="label ?? t('worktreeSession.showError')"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click.stop="toggle"
  >
    <Icon name="alert-triangle" size="sm" />
  </button>
  <Teleport to="body">
    <Transition name="sip-pop">
      <div
        v-if="open"
        :ref="setPopover"
        class="sip"
        role="dialog"
        :aria-label="title"
        :style="menuStyle"
        data-session-info-popover
        @click.stop
      >
        <div class="sip-title">{{ title }}</div>
        <p class="sip-body">{{ body }}</p>
        <WorktreeOutput v-if="hasOutput" class="sip-output" :text="output" />
        <div class="sip-actions">
          <Button class="sip-retry" variant="secondary" size="sm" :loading="busy" :disabled="busy" @click="emit('retry')">
            {{ t('worktreeSession.retry') }}
          </Button>
          <Button v-if="hasOutput" class="sip-copy" variant="ghost" size="sm" @click="copyOutput">
            {{ copyLabel }}
          </Button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sip-trigger {
  flex: none;
  width: var(--icon-button-sm);
  height: var(--icon-button-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  cursor: pointer;
}
.sip-trigger:hover,
.sip-trigger.open { box-shadow: inset 0 0 0 var(--p-hairline) var(--color-warning-bd); }
.sip-trigger:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
  box-sizing: border-box;
  width: 264px;
  max-width: calc(100vw - var(--space-4));
  padding: var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-menu-bg, var(--color-surface-raised));
  box-shadow: var(--shadow-menu, var(--shadow-sm));
  backdrop-filter: var(--p-menu-backdrop, blur(20px));
  color: var(--color-text);
  font-family: var(--font-ui);
}
.sip-title { color: var(--color-text-strong); font-size: var(--text-sm); font-weight: var(--weight-medium); line-height: var(--leading-tight); }
.sip-body { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); line-height: var(--leading-normal); }
.sip-output {
  margin-top: var(--space-2);
}
.sip-actions { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.sip-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.sip-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.sip-pop-enter-from,
.sip-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
