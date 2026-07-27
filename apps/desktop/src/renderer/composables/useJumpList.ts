// Desktop-only: push the recent workspace list to the native Jump List
// (Windows taskbar right-click menu; main/jump-list.ts), and route launch
// actions (Jump List item clicks, second-instance argv) back into the app.
// The list is pushed, not polled: the main process has no workspace data.
//
// With no bridge — plain web, tests — both sides are safe no-ops (per
// native-todos.md).

import { computed, watch, type ComputedRef, type Ref } from 'vue';

export interface JumpListWorkspaceEntry {
  name: string;
  root: string;
}

// The OS caps Jump List lists around 10 visible entries; headroom lives on
// the main side too (jump-list.ts MAX_WORKSPACES).
const MAX_ENTRIES = 9;

export type LaunchActionPayload = { action: 'new-chat' } | { action: 'open-workspace'; root: string };

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

/** Watch the entry list and push every change to the native Jump List. A null
    value (client state not loaded yet) is NOT pushed — at setup the workspace
    list is still empty, and wiping the OS menu for the whole load window is
    worse than showing slightly stale entries (same gating as the tray
    attention reporter). Identical successive lists are pushed once. Returns
    the stop handle; a missing bridge yields a no-op reporter. */
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

/** Subscribe to launch actions (main → renderer) and route them to the
    handler. Returns the unsubscribe; no-op without the bridge method. */
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
  /** Sidebar workspace view (display order = recency or the user's manual order). */
  workspacesView: ComputedRef<ReadonlyArray<{ name: string; root: string }>>;
  /** False until the client's first load() settles (see useWorkspaceState). */
  initialized: Ref<boolean>;
}

/** App.vue wiring: report the workspace list to the native Jump List, and
    route launch actions (Jump List clicks, second-instance argv) to the
    handler. Each bridge method degrades independently (an old bridge may lack
    either). Lives for the app's lifetime. */
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
