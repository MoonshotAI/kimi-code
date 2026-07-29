// apps/desktop/src/renderer/lib/nativeWorkspacePicker.ts
// Desktop-only workspace directory picking, backed by the Electron native open
// dialog (exposed as `window.kimiDesktop.showOpenDialog` by the desktop
// preload), plus the add-workspace entry flow that decides between the native
// picker and the in-app daemon-driven folder browser. Desktop-specific: the
// web app keeps the in-app browser only (see docs/native-todos.md).
//

import { track } from './track';

interface DesktopOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

// The desktop preload injects `window.kimiDesktop` unconditionally, so inside
// the Electron renderer the bridge always exists; its presence is the single
// "are we desktop" signal (and the only one we check).
interface DesktopBridge {
  showOpenDialog: (opts: Record<string, unknown>) => Promise<DesktopOpenDialogResult>;
}

/** True when running inside the desktop app — use the OS-native folder
 *  picker. False means use the in-app folder browser instead. */
export function canPickWorkspaceDirectory(): boolean {
  return (window as { kimiDesktop?: unknown }).kimiDesktop !== undefined;
}

export type PickDirectoryResult =
  | { status: 'picked'; path: string }
  | { status: 'canceled' }
  | { status: 'error' };

/**
 * Opens the OS-native "choose a folder" dialog for adding a workspace.
 * Distinguishes a user cancel from a bridge/IPC failure so callers can fall
 * back to the in-app browser on error instead of silently dropping the flow.
 * `createDirectory` lets the user make a brand-new project folder from inside
 * the panel.
 */
export async function pickWorkspaceDirectory(opts: { title: string }): Promise<PickDirectoryResult> {
  try {
    // Callers gate on canPickWorkspaceDirectory(); if the bridge is missing
    // anyway (or IPC fails), the throw lands in catch and reports an error.
    const result = await (window as unknown as { kimiDesktop: DesktopBridge }).kimiDesktop.showOpenDialog({
      title: opts.title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { status: 'canceled' };
    const path = result.filePaths[0];
    return path === undefined ? { status: 'canceled' } : { status: 'picked', path };
  } catch {
    return { status: 'error' };
  }
}

export interface AddWorkspaceEntryDeps {
  /** Whether the native picker can be used right now. */
  canPick: () => boolean;
  /** Open the native picker. */
  pick: () => Promise<PickDirectoryResult>;
  /** Attempt the add; resolves true only when the workspace was added. */
  add: (root: string) => Promise<boolean>;
  /** Show the in-app browser dialog (the non-native path and error surface). */
  openFallbackDialog: () => void;
  /** Drop a queued first-message submission (cancel semantics). */
  dropPending: () => void;
  /** Surface a generic add-failure error inside the fallback dialog. */
  reportError: () => void;
}

/**
 * The single entry behind every "add workspace" affordance. Native picker
 * first; the in-app browser is the fallback for no bridge, bridge errors, and
 * daemon rejections. Only an explicit user cancel drops a queued submission.
 * Re-entry while a pick is in flight is ignored (no stacked native dialogs).
 */
export function createAddWorkspaceEntry(deps: AddWorkspaceEntryDeps): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!deps.canPick()) {
        track('native_feature_used', { feature: 'workspace_picker', fallback: true });
        deps.openFallbackDialog();
        return;
      }
      const result = await deps.pick();
      if (result.status === 'canceled') {
        // An explicit cancel is neither a native success nor a fallback — no event.
        deps.dropPending();
        return;
      }
      if (result.status === 'error') {
        track('native_feature_used', { feature: 'workspace_picker', fallback: true });
        deps.reportError();
        deps.openFallbackDialog();
        return;
      }
      const added = await deps.add(result.path);
      if (!added) {
        track('native_feature_used', { feature: 'workspace_picker', fallback: true });
        deps.reportError();
        deps.openFallbackDialog();
        return;
      }
      track('native_feature_used', { feature: 'workspace_picker' });
    } finally {
      inFlight = false;
    }
  };
}
