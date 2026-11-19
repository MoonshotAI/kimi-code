
interface DesktopBridge {
  getPathForFile?: (file: File) => string | null;
}

function bridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { kimiDesktop?: DesktopBridge }).kimiDesktop;
}

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

export function resolveFilePath(file: File): string | null {
  return getPathViaBridge(file);
}

export function looksLikeFolderDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.items ?? []).some(
    (item) => item.kind === 'file' && item.type === '',
  );
}

export type DroppedItem = { kind: 'folder'; path: string } | { kind: 'file'; file: File };

export function partitionDroppedItems(
  event: DragEvent,
  getPath: (file: File) => string | null = getPathViaBridge,
): { files: File[]; folderPaths: string[]; items: DroppedItem[] } {
  const items = Array.from(event.dataTransfer?.items ?? []);
  if (items.length === 0) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    return { files, folderPaths: [], items: files.map((file) => ({ kind: 'file', file })) };
  }
  const files: File[] = [];
  const folderPaths: string[] = [];
  const ordered: DroppedItem[] = [];
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
      ordered.push({ kind: 'folder', path });
    } else {
      files.push(file);
      ordered.push({ kind: 'file', file });
    }
  }
  return { files, folderPaths, items: ordered };
}

export function extractDroppedFolderPaths(
  event: DragEvent,
  getPath: (file: File) => string | null = getPathViaBridge,
): string[] {
  return partitionDroppedItems(event, getPath).folderPaths;
}

export function partitionPastedItems(
  cd: DataTransfer,
  getPath: (file: File) => string | null = getPathViaBridge,
): { files: File[]; folderPaths: string[]; hasFolders: boolean; items: DroppedItem[] } {
  const keyOf = (file: File): string => `${file.size}:${file.type}:${file.name}`;
  const files: File[] = [];
  const seenFiles = new Set<string>();
  const folderKeys = new Set<string>();
  const folderPaths: string[] = [];
  const seenPaths = new Set<string>();
  const items: DroppedItem[] = [];
  let hasFolders = false;

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
      items.push({ kind: 'folder', path });
      continue;
    }
    if (!file) continue;
    const key = keyOf(file);
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    files.push(file);
    items.push({ kind: 'file', file });
  }

  for (const file of Array.from(cd.files ?? [])) {
    const key = keyOf(file);
    if (folderKeys.has(key) || seenFiles.has(key)) continue;
    seenFiles.add(key);
    files.push(file);
    items.push({ kind: 'file', file });
  }

  return { files, folderPaths, hasFolders, items };
}
