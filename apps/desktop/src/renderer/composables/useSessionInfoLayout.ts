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

function trailingSpace(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0) return 0;
  return Math.max(0, parent.getBoundingClientRect().right - rect.right);
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
  const unobstructedWidth = ref(0);
  let observer: ResizeObserver | null = null;

  function measure(element: HTMLElement, width: number): void {
    hostWidth.value = width;
    unobstructedWidth.value = width + trailingSpace(element);
  }

  watch(input.host, (element) => {
    observer?.disconnect();
    observer = null;
    hostWidth.value = 0;
    unobstructedWidth.value = 0;
    if (!element) return;
    measure(element, element.clientWidth);
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver((entries) => {
        measure(element, entries[0]?.contentRect.width ?? element.clientWidth);
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

  const mode = computed<SessionInfoMode>(() => sessionInfoModeForWidth(
    input.rightPanelOpen.value ? hostWidth.value : unobstructedWidth.value,
  ));
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
