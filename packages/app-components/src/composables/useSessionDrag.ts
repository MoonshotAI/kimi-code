import { ref } from 'vue';
import {
  SESSION_ROW_DRAG_MIME,
  WORKSPACE_DRAG_MIME,
  moveInOrder,
  pinnedSessionKey,
  pinnedWorkspaceKey,
  type DropPosition,
  type PinnedInsertTarget,
} from '@moonshot-ai/app-core/lib';

export interface PinnedDragSession {
  id: string;
  workspaceId: string;
}

const pinnedDragSession = ref<PinnedDragSession | null>(null);
const pinnedEntryDragKey = ref<string | null>(null);
const pinnedEntryDragOver = ref<{ key: string; position: DropPosition } | null>(null);
const workspaceDragId = ref<string | null>(null);
const workspaceDragOver = ref<{ id: string; position: DropPosition } | null>(null);

export function useSessionDrag() {
  return {
    pinnedDragSession,
    pinnedEntryDragKey,
    pinnedEntryDragOver,
    workspaceDragId,
    workspaceDragOver,
    startSessionRowDrag,
    startPinnedRowDrag,
    endPinnedRowDrag,
    startWorkspaceDrag,
    endWorkspaceDrag,
  };
}

export function startSessionRowDrag(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(SESSION_ROW_DRAG_MIME, id);
  event.dataTransfer.setData('text/plain', id);
}

export function startPinnedRowDrag(id: string, workspaceId: string | undefined, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
  pinnedEntryDragKey.value = pinnedSessionKey(id);
  if (workspaceId !== undefined) pinnedDragSession.value = { id, workspaceId };
}

export function endPinnedRowDrag(): void {
  pinnedDragSession.value = null;
  pinnedEntryDragKey.value = null;
  pinnedEntryDragOver.value = null;
}

export function startWorkspaceDrag(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(WORKSPACE_DRAG_MIME, id);
  event.dataTransfer.setData('text/plain', id);
  workspaceDragId.value = id;
}

export function endWorkspaceDrag(): void {
  workspaceDragId.value = null;
  workspaceDragOver.value = null;
  pinnedEntryDragOver.value = null;
}

export function isSessionRowDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(SESSION_ROW_DRAG_MIME) ?? false;
}

export function isWorkspaceRowDrag(event: DragEvent): boolean {
  return workspaceDragId.value !== null || (event.dataTransfer?.types.includes(WORKSPACE_DRAG_MIME) ?? false);
}

function leavesContainer(event: DragEvent): boolean {
  return (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null);
}

export function usePinnedDropTarget(onDropPin: (id: string) => void) {
  const dropActive = ref(false);

  function onDragOver(event: DragEvent): void {
    if (!isSessionRowDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropActive.value = true;
  }

  function onDrop(event: DragEvent): void {
    dropActive.value = false;
    const droppedId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME);
    if (droppedId) onDropPin(droppedId);
  }

  function onDragLeave(event: DragEvent): void {
    if (leavesContainer(event)) return;
    dropActive.value = false;
  }

  return { dropActive, onDragOver, onDrop, onDragLeave };
}

export function usePinnedReturnTarget(options: {
  isTarget: () => boolean;
  onReturn: (id: string) => void;
  blockedCursor?: boolean;
}) {
  const dropHover = ref(false);

  function onDragOver(event: DragEvent): void {
    if (pinnedDragSession.value === null) return;
    if (!options.isTarget()) {
      if (options.blockedCursor === true && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropHover.value = true;
  }

  function onDrop(event: DragEvent): void {
    const drag = pinnedDragSession.value;
    if (drag === null || !options.isTarget()) return;
    event.preventDefault();
    dropHover.value = false;
    endPinnedRowDrag();
    options.onReturn(drag.id);
  }

  function onDragLeave(event: DragEvent): void {
    if (leavesContainer(event)) return;
    dropHover.value = false;
  }

  return { dropHover, onDragOver, onDrop, onDragLeave };
}

function dropPositionOf(event: DragEvent): DropPosition {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

export function usePinnedListDrag(options: {
  getEntries: () => readonly { key: string }[];
  isPinnedWorkspace: (id: string) => boolean;
  onReorder: (fromKey: string, toKey: string, position: DropPosition) => void;
  onDropPinSession: (sessionId: string, target?: PinnedInsertTarget) => void;
  onDropPinWorkspace: (workspaceId: string, target?: PinnedInsertTarget) => void;
}) {
  const dropActive = ref(false);

  function activeReorderKey(): string | null {
    if (pinnedEntryDragKey.value !== null) return pinnedEntryDragKey.value;
    const wsId = workspaceDragId.value;
    if (wsId !== null && options.isPinnedWorkspace(wsId)) return pinnedWorkspaceKey(wsId);
    return null;
  }

  function unpinnedWorkspaceDrag(event: DragEvent): boolean {
    if (workspaceDragId.value !== null) return !options.isPinnedWorkspace(workspaceDragId.value);
    return event.dataTransfer?.types.includes(WORKSPACE_DRAG_MIME) ?? false;
  }

  function resolveUnpinnedWorkspaceId(event: DragEvent): string | null {
    const activeWs = workspaceDragId.value;
    if (activeWs !== null) return options.isPinnedWorkspace(activeWs) ? null : activeWs;
    const fromTransfer = event.dataTransfer?.getData(WORKSPACE_DRAG_MIME) ?? '';
    return fromTransfer && !options.isPinnedWorkspace(fromTransfer) ? fromTransfer : null;
  }

  function onEntryDragOver(targetKey: string, event: DragEvent): void {
    const fromKey = activeReorderKey();
    if (fromKey !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      dropActive.value = false;
      pinnedEntryDragOver.value =
        fromKey === targetKey ? null : { key: targetKey, position: dropPositionOf(event) };
      return;
    }
    if (!isSessionRowDrag(event) && !unpinnedWorkspaceDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropActive.value = false;
    pinnedEntryDragOver.value = { key: targetKey, position: dropPositionOf(event) };
  }

  function onEntryDrop(targetKey: string, event: DragEvent): void {
    const position =
      pinnedEntryDragOver.value?.key === targetKey
        ? pinnedEntryDragOver.value.position
        : dropPositionOf(event);
    const fromKey = activeReorderKey();
    if (fromKey !== null) {
      event.preventDefault();
      event.stopPropagation();
      pinnedEntryDragOver.value = null;
      dropActive.value = false;
      endPinnedRowDrag();
      endWorkspaceDrag();
      if (fromKey !== targetKey) options.onReorder(fromKey, targetKey, position);
      return;
    }
    const wsId = resolveUnpinnedWorkspaceId(event);
    if (wsId !== null) {
      event.preventDefault();
      event.stopPropagation();
      pinnedEntryDragOver.value = null;
      dropActive.value = false;
      endWorkspaceDrag();
      options.onDropPinWorkspace(wsId, { key: targetKey, position });
      return;
    }
    const sessionId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME) ?? '';
    if (sessionId) {
      event.preventDefault();
      event.stopPropagation();
      pinnedEntryDragOver.value = null;
      dropActive.value = false;
      options.onDropPinSession(sessionId, { key: targetKey, position });
    }
  }

  function onEntryDragLeave(targetKey: string, event: DragEvent): void {
    if (leavesContainer(event)) return;
    if (pinnedEntryDragOver.value?.key === targetKey) pinnedEntryDragOver.value = null;
  }

  function onContainerDragOver(event: DragEvent): void {
    const fromKey = activeReorderKey();
    if (fromKey !== null) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      pinnedEntryDragOver.value = null;
      dropActive.value = false;
      return;
    }
    if (!isSessionRowDrag(event) && !unpinnedWorkspaceDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    pinnedEntryDragOver.value = null;
    dropActive.value = true;
  }

  function onContainerDrop(event: DragEvent): void {
    pinnedEntryDragOver.value = null;
    dropActive.value = false;
    const fromKey = activeReorderKey();
    if (fromKey !== null) {
      event.preventDefault();
      const entries = options.getEntries();
      const inHeader = (event.target as Element | null)?.closest?.('.pinned-label') !== null;
      const anchorKey = inHeader ? entries[0]?.key : entries[entries.length - 1]?.key;
      const position: DropPosition = inHeader ? 'before' : 'after';
      endPinnedRowDrag();
      endWorkspaceDrag();
      if (anchorKey && anchorKey !== fromKey) options.onReorder(fromKey, anchorKey, position);
      return;
    }
    const wsId = resolveUnpinnedWorkspaceId(event);
    if (wsId !== null) {
      event.preventDefault();
      endWorkspaceDrag();
      options.onDropPinWorkspace(wsId);
      return;
    }
    const sessionId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME) ?? '';
    if (sessionId) {
      event.preventDefault();
      options.onDropPinSession(sessionId);
    }
  }

  function onContainerDragLeave(event: DragEvent): void {
    if (leavesContainer(event)) return;
    dropActive.value = false;
    pinnedEntryDragOver.value = null;
  }

  return {
    dropActive,
    entryDragOver: pinnedEntryDragOver,
    onEntryDragOver,
    onEntryDrop,
    onEntryDragLeave,
    onContainerDragOver,
    onContainerDrop,
    onContainerDragLeave,
  };
}

export function useWorkspaceReorder(options: {
  getOrder: () => string[];
  onReorder: (next: string[]) => void;
  enabled?: () => boolean;
}) {
  function isAllowed(fromId: string | null): fromId is string {
    if (fromId === null) return false;
    return options.enabled ? options.enabled() : true;
  }

  function onDragOver(event: DragEvent, targetId: string): void {
    const fromId = workspaceDragId.value;
    if (!isAllowed(fromId) || fromId === targetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    workspaceDragOver.value = { id: targetId, position: dropPositionOf(event) };
  }

  function onDrop(targetId: string): void {
    const fromId = workspaceDragId.value;
    if (!isAllowed(fromId)) {
      workspaceDragOver.value = null;
      workspaceDragId.value = null;
      return;
    }
    const position =
      workspaceDragOver.value?.id === targetId ? workspaceDragOver.value.position : 'before';
    workspaceDragOver.value = null;
    workspaceDragId.value = null;
    if (fromId === targetId) return;
    options.onReorder(moveInOrder(options.getOrder(), fromId, targetId, position));
  }

  return { onDragOver, onDrop };
}
