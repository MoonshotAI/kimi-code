import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { loadSessionInfoPanelEnabled, saveSessionInfoPanelEnabled } from '@moonshot-ai/app-core/lib';

export const SESSION_INFO_SIDEBAR_WIDTH = 280;
export const SESSION_INFO_MIN_CONVERSATION_WIDTH = 680;
export const SESSION_INFO_SIDEBAR_THRESHOLD = SESSION_INFO_SIDEBAR_WIDTH + SESSION_INFO_MIN_CONVERSATION_WIDTH;

export type SessionInfoMode = 'sidebar' | 'floating';

export function sessionInfoModeForWidth(width: number): SessionInfoMode {
  return width >= SESSION_INFO_SIDEBAR_THRESHOLD ? 'sidebar' : 'floating';
}

export function sessionInfoPanelVisible(input: {
  enabled: boolean;
  eligible: boolean;
  activeSessionId?: string;
}): boolean {
  return input.enabled && input.eligible && input.activeSessionId !== undefined;
}

export function useSessionInfoLayout(input: {
  host: Ref<HTMLElement | null>;
  activeSessionId: Ref<string | undefined>;
  rightPanelOpen: Ref<boolean>;
  eligible: Ref<boolean>;
}) {
  const enabled = ref(loadSessionInfoPanelEnabled());
  const rightPanelCollapsed = ref(false);
  const floatingExpanded = ref(false);
  const hostWidth = ref(0);
  let observer: ResizeObserver | null = null;

  watch(input.host, (element) => {
    observer?.disconnect();
    observer = null;
    hostWidth.value = element?.clientWidth ?? 0;
    if (element && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver((entries) => {
        hostWidth.value = entries[0]?.contentRect.width ?? element.clientWidth;
      });
      observer.observe(element);
    }
  }, { immediate: true, flush: 'post' });

  watch(input.rightPanelOpen, (open) => {
    rightPanelCollapsed.value = open;
  }, { immediate: true, flush: 'sync' });

  onScopeDispose(() => {
    observer?.disconnect();
    observer = null;
  });

  const mode = computed<SessionInfoMode>(() => sessionInfoModeForWidth(hostWidth.value));
  watch(mode, () => {
    floatingExpanded.value = false;
  }, { flush: 'sync' });

  const visible = computed(() => sessionInfoPanelVisible({
    enabled: mode.value === 'sidebar' ? enabled.value : floatingExpanded.value,
    eligible: input.eligible.value,
    activeSessionId: input.activeSessionId.value,
  }) && !rightPanelCollapsed.value);

  function toggle(): void {
    if (!input.rightPanelOpen.value && mode.value === 'sidebar') {
      enabled.value = !enabled.value;
      saveSessionInfoPanelEnabled(enabled.value);
      return;
    }
    if (input.rightPanelOpen.value) {
      if (!enabled.value) {
        enabled.value = true;
        saveSessionInfoPanelEnabled(true);
      }
      if (mode.value === 'floating') {
        const expand = rightPanelCollapsed.value || !floatingExpanded.value;
        rightPanelCollapsed.value = !expand;
        floatingExpanded.value = expand;
      } else {
        rightPanelCollapsed.value = !rightPanelCollapsed.value;
      }
      return;
    }
    floatingExpanded.value = !floatingExpanded.value;
  }

  return { enabled, hostWidth, mode, visible, toggle };
}
