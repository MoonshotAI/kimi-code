// apps/web/src/lib/nativeWorkspaceDrop.ts
// Folder-drag support for two call sites: "drop a folder on the sidebar to
// create a workspace" and "drop a folder on the composer to insert its path".
// Recovering an absolute path from a dropped File is impossible in a plain
// browser (and File.path is gone in modern Electron) — the desktop preload
// exposes `window.kimiDesktop.getPathForFile` (webUtils) for exactly this.
// Everything here is bridge-gated, so the web build ships this file inert:
// no bridge → no affordance, no interception, drops keep their old meaning
// (file attachments), and dropped folders resolve to no path at all.

interface DesktopBridge {
  getPathForFile?: (file: File) => string | null;
}

function bridge(): DesktopBridge | undefined {
  return (window as { kimiDesktop?: DesktopBridge }).kimiDesktop;
}

/** True when dropped folders can be resolved to absolute paths (desktop app
 *  with a new-enough preload). False means the sidebar must not intercept
 *  folder drags at all. */
export function canDropWorkspaceFolders(): boolean {
  return typeof bridge()?.getPathForFile === 'function';
}

function getPathViaBridge(file: File): string | null {
  const getPathForFile = bridge()?.getPathForFile;
  if (typeof getPathForFile !== 'function') return null;
  try {
    return getPathForFile(file);
  } catch {
    return null;
  }
}

/**
 * dragenter/dragover heuristic: is this drag likely to contain a folder?
 * During a drag the DataTransfer is in protected mode — item data (and
 * `webkitGetAsEntry`) is withheld, only `kind`/`type` are readable. Folders
 * report `kind: 'file'` with an empty MIME type. False positives (e.g. an
 * extensionless file) are harmless: the highlight is cosmetic and the drop
 * handler re-checks authoritatively before intercepting anything.
 */
export function looksLikeFolderDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.items ?? []).some(
    (item) => item.kind === 'file' && item.type === '',
  );
}

/**
 * Authoritative drop-time split of the DataTransfer: plain files (safe to
 * upload) vs. dropped folders (their absolute paths, de-duplicated). Folders
 * whose path cannot be resolved — no bridge, or a drag with no file backing —
 * are skipped entirely, so on web they are simply ignored rather than sent to
 * the upload endpoint (which rejects them). When the item list is unreadable
 * the files fall back to `dataTransfer.files`, preserving the old behavior.
 */
export function partitionDroppedItems(
  event: DragEvent,
  getPath: (file: File) => string | null = getPathViaBridge,
): { files: File[]; folderPaths: string[] } {
  const items = Array.from(event.dataTransfer?.items ?? []);
  if (items.length === 0) {
    return { files: Array.from(event.dataTransfer?.files ?? []), folderPaths: [] };
  }
  const files: File[] = [];
  const folderPaths: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) {
      const path = getPath(file);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      folderPaths.push(path);
    } else {
      files.push(file);
    }
  }
  return { files, folderPaths };
}

/**
 * Authoritative drop-time extraction: absolute paths of every dropped
 * folder, de-duplicated. Non-folder entries (plain files) and items whose
 * path cannot be resolved are skipped — the caller decides whether an empty
 * result means "not ours, let the drop bubble on".
 */
export function extractDroppedFolderPaths(
  event: DragEvent,
  getPath: (file: File) => string | null = getPathViaBridge,
): string[] {
  return partitionDroppedItems(event, getPath).folderPaths;
}
