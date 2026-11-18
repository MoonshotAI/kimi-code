import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  insertPinnedOrderKey,
  loadPinnedOrder,
  moveInOrder,
  reconcilePinnedOrder,
  savePinnedOrder,
  savePinnedSessions,
  savePinnedWorkspaces,
  splitPinnedOrder,
  type DropPosition,
  type PinnedInsertTarget,
} from '@moonshot-ai/app-core/lib';
import { clientPinia } from './pinia';
import { sessionsStore } from './sessions';
import { workspacesStore } from './workspaces';

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, idx) => item === b[idx]);
}

export const usePinnedOrderStore = defineStore('kimi.pinnedOrder', () => {
  const pinnedOrder = ref<string[]>(loadPinnedOrder());

  function commitOrder(
    nextOrder: string[],
    options: { syncSubLists?: boolean } = {},
  ): void {
    if (!arraysEqual(pinnedOrder.value, nextOrder)) {
      pinnedOrder.value = nextOrder;
      savePinnedOrder(nextOrder);
    }
    if (options.syncSubLists) {
      const { workspaceIds, sessionIds } = splitPinnedOrder(nextOrder);
      const ws = workspacesStore();
      if (!arraysEqual(ws.pinnedWorkspaceIds, workspaceIds)) {
        ws.pinnedWorkspaceIds = workspaceIds;
        savePinnedWorkspaces(workspaceIds);
      }
      const sessions = sessionsStore();
      if (!arraysEqual(sessions.pinnedSessionIds, sessionIds)) {
        sessions.pinnedSessionIds = sessionIds;
        savePinnedSessions(sessionIds);
      }
    }
  }

  function placeKey(key: string, target?: PinnedInsertTarget): void {
    const base = reconcilePinnedOrder(
      pinnedOrder.value,
      workspacesStore().pinnedWorkspaceIds,
      sessionsStore().pinnedSessionIds,
    );
    const next = insertPinnedOrderKey(base, key, target);
    commitOrder(next, { syncSubLists: true });
  }

  function removeKeys(keys: Iterable<string>): void {
    const stale = new Set(keys);
    if (stale.size === 0) return;
    const next = pinnedOrder.value.filter((existing) => !stale.has(existing));
    if (next.length === pinnedOrder.value.length) return;
    pinnedOrder.value = next;
    savePinnedOrder(next);
  }

  function reorder(fromKey: string, toKey: string, position: DropPosition): void {
    const base = reconcilePinnedOrder(
      pinnedOrder.value,
      workspacesStore().pinnedWorkspaceIds,
      sessionsStore().pinnedSessionIds,
    );
    const next = moveInOrder(base, fromKey, toKey, position);
    if (next === base) return;
    commitOrder(next, { syncSubLists: true });
  }

  return {
    pinnedOrder,
    placeKey,
    removeKeys,
    reorder,
  };
});

export function pinnedOrderStore() {
  return usePinnedOrderStore(clientPinia);
}
