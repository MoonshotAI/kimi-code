// packages/app-core/src/lib/nativeWorkspaceDrop.ts
// Folder-drag/paste support for two call sites: "drop a folder on the sidebar
// to create a workspace" and "drop or paste a folder on the composer to insert
// its path". Recovering an absolute path from a dropped File is impossible in
// a plain browser (and File.path is gone in modern Electron) — the desktop
// preload exposes `window.kimiDesktop.getPathForFile` (webUtils) for exactly
// this. Everything here is bridge-gated, so the web build ships this file
// inert: no bridge → no affordance, no interception, drops keep their old
// meaning (file attachments), and dropped or pasted folders resolve to no
// path at all.

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

/**
 * Paste-time split of the clipboard, mirroring partitionDroppedItems: plain
 * files (safe to upload) vs. pasted folders (their absolute paths,
 * de-duplicated). A copied-and-pasted folder surfaces as a `kind: 'file'`
 * item whose File is a directory stub — uploading one makes the request fail
 * and surfaces as a daemon connection error, so folder stubs must never reach
 * the upload path. Folders whose path cannot be resolved (no bridge, or a
 * clipboard with no file backing) are skipped entirely, so on web they are
 * simply ignored rather than uploaded. Files are de-duplicated across `items`
 * and `files` (some browsers/OS put screenshots in only one of the two), and
 * folder stubs are excluded from the result explicitly: a pasted directory's
 * File also shows up in `dataTransfer.files`, where no directory marker
 * survives to identify it.
 *
 * `hasFolders` reports that directory entries were seen at all, resolved or
 * not — the paste handler needs it to swallow the browser's default paste
 * even when no path resolves: without it, a clipboard carrying the folder
 * plus its name as `text/plain` (what file managers copy) would insert the
 * bare folder name into the draft, half-doing what "ignore the folder" means.
 */
export function partitionPastedItems(
  cd: DataTransfer,
  getPath: (file: File) => string | null = getPathViaBridge,
): { files: File[]; folderPaths: string[]; hasFolders: boolean } {
  const keyOf = (file: File): string => `${file.size}:${file.type}:${file.name}`;
  const files: File[] = [];
  const seenFiles = new Set<string>();
  const folderKeys = new Set<string>();
  const folderPaths: string[] = [];
  const seenPaths = new Set<string>();
  let hasFolders = false;

  // Pass 1 — items: the only list whose entries still carry the directory
  // marker (webkitGetAsEntry).
  for (const item of Array.from(cd.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (item.webkitGetAsEntry?.()?.isDirectory === true) {
      hasFolders = true;
      if (file) folderKeys.add(keyOf(file));
      const path = file ? getPath(file) : null;
      if (!path || seenPaths.has(path)) continue;
      seenPaths.add(path);
      folderPaths.push(path);
      continue;
    }
    if (!file) continue;
    const key = keyOf(file);
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    files.push(file);
  }

  // Pass 2 — files: some browsers/OS put screenshots here directly. Folder
  // stubs already seen in pass 1 are excluded by key.
  for (const file of Array.from(cd.files ?? [])) {
    const key = keyOf(file);
    if (folderKeys.has(key) || seenFiles.has(key)) continue;
    seenFiles.add(key);
    files.push(file);
  }

  return { files, folderPaths, hasFolders };
}
