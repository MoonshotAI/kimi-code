import { computed, onScopeDispose, shallowRef } from 'vue';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';

export interface WorkspaceHoverAnchor {
  right: number;
  top: number;
}

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 140;
const CARD_WIDTH = 460;

export function useWorkspaceHoverCard() {
  const workspace = shallowRef<WorkspaceView | null>(null);
  const anchor = shallowRef<WorkspaceHoverAnchor | null>(null);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const cardStyle = computed(() => {
    if (!anchor.value || typeof window === 'undefined') return {};
    const width = Math.min(CARD_WIDTH, window.innerWidth - 24);
    const height = 104 + (workspace.value?.additionalDirs.length ?? 0) * 36 + 36;
    return {
      left: `${Math.max(12, Math.min(anchor.value.right + 12, window.innerWidth - width - 12))}px`,
      top: `${Math.max(12, Math.min(anchor.value.top - 4, window.innerHeight - height - 12))}px`,
      maxWidth: `${width}px`,
      maxHeight: `${Math.max(120, window.innerHeight - 24)}px`,
    };
  });

  function clearTimers(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  }

  function close(): void {
    clearTimers();
    workspace.value = null;
    anchor.value = null;
  }

  function scheduleOpen(nextWorkspace: WorkspaceView, nextAnchor: WorkspaceHoverAnchor): void {
    clearTimers();
    if (workspace.value?.id === nextWorkspace.id) return;
    openTimer = setTimeout(() => {
      workspace.value = nextWorkspace;
      anchor.value = nextAnchor;
      openTimer = undefined;
    }, OPEN_DELAY_MS);
  }

  function cancelClose(): void {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function scheduleClose(): void {
    clearTimeout(openTimer);
    openTimer = undefined;
    cancelClose();
    closeTimer = setTimeout(close, CLOSE_DELAY_MS);
  }

  if (typeof window !== 'undefined') window.addEventListener('resize', close);
  onScopeDispose(() => {
    if (typeof window !== 'undefined') window.removeEventListener('resize', close);
    close();
  });

  return { workspace, cardStyle, scheduleOpen, cancelClose, scheduleClose, close };
}
