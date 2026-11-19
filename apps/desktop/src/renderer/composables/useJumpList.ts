
import { computed, watch, type ComputedRef, type Ref } from 'vue';

export interface JumpListWorkspaceEntry {
  name: string;
  root: string;
}

const MAX_ENTRIES = 9;

export type LaunchActionPayload = { action: 'new-chat' } | { action: 'open-workspace'; root: string; newChat?: boolean };

interface JumpListBridge {
  setJumpList?: (workspaces: JumpListWorkspaceEntry[]) => void;
  onLaunchAction?: (cb: (payload: LaunchActionPayload) => void) => () => void;
}

function bridge(): JumpListBridge | undefined {
  return (window as { kimiDesktop?: JumpListBridge }).kimiDesktop;
}

export function jumpListEntriesEqual(
  a: JumpListWorkspaceEntry[],
  b: JumpListWorkspaceEntry[],
): boolean {
  return a.length === b.length && a.every((entry, i) => entry.name === b[i]!.name && entry.root === b[i]!.root);
}

export function createJumpListReporter(
  reporter: { setJumpList: (workspaces: JumpListWorkspaceEntry[]) => void } | undefined,
  entries: ComputedRef<JumpListWorkspaceEntry[] | null>,
): () => void {
  if (reporter === undefined) {
    return () => {};
  }
  let lastPushed: JumpListWorkspaceEntry[] | null = null;
  return watch(
    entries,
    (value) => {
      if (value === null) return;
      if (lastPushed !== null && jumpListEntriesEqual(value, lastPushed)) {
        return;
      }
      lastPushed = value;
      reporter.setJumpList(value);
    },
    { immediate: true },
  );
}

export function createLaunchActionRouter(
  subscriber: {
    onLaunchAction: (cb: (payload: LaunchActionPayload) => void) => () => void;
  } | undefined,
  handler: (payload: LaunchActionPayload) => void,
): () => void {
  if (subscriber === undefined) {
    return () => {};
  }
  return subscriber.onLaunchAction(handler);
}

interface JumpListSource {
  workspacesView: ComputedRef<ReadonlyArray<{ name: string; root: string }>>;
  initialized: Ref<boolean>;
}

export function useJumpList(
  client: JumpListSource,
  onLaunchAction: (payload: LaunchActionPayload) => void,
): void {
  const b = bridge();
  const setJumpList = b?.setJumpList;
  if (typeof setJumpList === 'function') {
    const entries = computed<JumpListWorkspaceEntry[] | null>(() => {
      if (!client.initialized.value) return null;
      return client.workspacesView.value
        .slice(0, MAX_ENTRIES)
        .map((workspace) => ({ name: workspace.name, root: workspace.root }));
    });
    createJumpListReporter({ setJumpList }, entries);
  }
  const subscribe = b?.onLaunchAction;
  if (typeof subscribe === 'function') {
    createLaunchActionRouter({ onLaunchAction: subscribe }, onLaunchAction);
  }
}
