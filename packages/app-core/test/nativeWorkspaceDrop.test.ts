import { afterEach, describe, expect, it } from 'vitest';

import {
  canDropWorkspaceFolders,
  extractDroppedFolderPaths,
  looksLikeFolderDrag,
  partitionDroppedItems,
  partitionPastedItems,
} from '../src/lib/nativeWorkspaceDrop';

// Renderer tests run in the node environment, so there is no real `window`;
// each test installs just enough of it to stand in for the preload bridge.
const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalRef.window;
  } else {
    globalRef.window = originalWindow;
  }
});

function setBridge(bridge: unknown): void {
  globalRef.window = bridge === undefined ? {} : { kimiDesktop: bridge };
}

function fakeItem(opts: {
  kind?: string;
  type?: string;
  isDirectory?: boolean;
  file?: File | null;
}): DataTransferItem {
  const file = opts.file === undefined ? new File(['x'], 'entry') : opts.file;
  return {
    kind: opts.kind ?? 'file',
    type: opts.type ?? '',
    webkitGetAsEntry: () =>
      opts.isDirectory === undefined ? null : { isDirectory: opts.isDirectory } as FileSystemEntry,
    getAsFile: () => file,
  } as unknown as DataTransferItem;
}

function fakeDragEvent(items: DataTransferItem[]): DragEvent {
  return { dataTransfer: { items } } as unknown as DragEvent;
}

describe('canDropWorkspaceFolders', () => {
  it('is false when the desktop bridge is absent (web build)', () => {
    setBridge(undefined);
    expect(canDropWorkspaceFolders()).toBe(false);
  });

  it('is false when the bridge lacks getPathForFile (older preload)', () => {
    setBridge({});
    expect(canDropWorkspaceFolders()).toBe(false);
  });

  it('is true when the bridge exposes getPathForFile', () => {
    setBridge({ getPathForFile: () => '/x' });
    expect(canDropWorkspaceFolders()).toBe(true);
  });
});

describe('looksLikeFolderDrag', () => {
  it('is true when an item is a file with an empty MIME type (folders)', () => {
    expect(looksLikeFolderDrag(fakeDragEvent([fakeItem({ type: '' })]))).toBe(true);
  });

  it('is false for typed files', () => {
    expect(looksLikeFolderDrag(fakeDragEvent([fakeItem({ type: 'image/png' })]))).toBe(false);
  });

  it('is false for non-file drags (e.g. workspace reorder text payload)', () => {
    expect(looksLikeFolderDrag(fakeDragEvent([fakeItem({ kind: 'string', type: 'text/plain' })]))).toBe(false);
  });

  it('is false when the drag carries no items', () => {
    expect(looksLikeFolderDrag(fakeDragEvent([]))).toBe(false);
    expect(looksLikeFolderDrag({ dataTransfer: null } as unknown as DragEvent)).toBe(false);
  });
});

describe('extractDroppedFolderPaths', () => {
  it('keeps only directory entries, mapping them through the path resolver', () => {
    const dir = fakeItem({ isDirectory: true });
    const file = fakeItem({ isDirectory: false, type: 'image/png' });
    const event = fakeDragEvent([dir, file]);
    const paths = extractDroppedFolderPaths(event, () => '/work/dir');
    expect(paths).toEqual(['/work/dir']);
  });

  it('supports multiple folders and de-duplicates resolved paths', () => {
    const a = fakeItem({ isDirectory: true, file: new File(['x'], 'a') });
    const b = fakeItem({ isDirectory: true, file: new File(['x'], 'b') });
    const c = fakeItem({ isDirectory: true, file: new File(['x'], 'c') });
    const byName = (f: File) => `/work/${f.name}`;
    const paths = extractDroppedFolderPaths(fakeDragEvent([a, b, c]), (f) =>
      f.name === 'c' ? '/work/a' : byName(f),
    );
    expect(paths).toEqual(['/work/a', '/work/b']);
  });

  it('skips entries whose path cannot be resolved', () => {
    const dir = fakeItem({ isDirectory: true });
    expect(extractDroppedFolderPaths(fakeDragEvent([dir]), () => null)).toEqual([]);
  });

  it('skips items without a File or directory entry', () => {
    const noFile = fakeItem({ isDirectory: true, file: null });
    const noEntry = fakeItem({ isDirectory: undefined });
    const stringItem = fakeItem({ kind: 'string', type: 'text/plain' });
    expect(
      extractDroppedFolderPaths(fakeDragEvent([noFile, noEntry, stringItem]), () => '/work/dir'),
    ).toEqual([]);
  });

  it('defaults to the desktop bridge and returns empty without one', () => {
    const dir = fakeItem({ isDirectory: true });
    setBridge({ getPathForFile: () => '/work/dir' });
    expect(extractDroppedFolderPaths(fakeDragEvent([dir]))).toEqual(['/work/dir']);

    setBridge(undefined);
    expect(extractDroppedFolderPaths(fakeDragEvent([dir]))).toEqual([]);
  });

  it('treats a throwing bridge as unresolvable', () => {
    setBridge({
      getPathForFile: () => {
        throw new Error('bad file');
      },
    });
    expect(extractDroppedFolderPaths(fakeDragEvent([fakeItem({ isDirectory: true })]))).toEqual([]);
  });
});

describe('partitionDroppedItems', () => {
  it('splits plain files from folders, resolving folder paths', () => {
    const png = new File(['x'], 'a.png');
    const dirFile = new File(['x'], 'dir');
    const event = fakeDragEvent([
      fakeItem({ isDirectory: false, type: 'image/png', file: png }),
      fakeItem({ isDirectory: true, file: dirFile }),
    ]);
    const { files, folderPaths } = partitionDroppedItems(event, () => '/work/dir');
    expect(files).toEqual([png]);
    expect(folderPaths).toEqual(['/work/dir']);
  });

  it('keeps the drag item order interleaved across folders and files (both are document pills now)', () => {
    const a = new File(['x'], 'a.txt');
    const dirFile = new File(['x'], 'dir');
    const b = new File(['y'], 'b.txt');
    const event = fakeDragEvent([
      fakeItem({ isDirectory: false, type: 'text/plain', file: a }),
      fakeItem({ isDirectory: true, file: dirFile }),
      fakeItem({ isDirectory: false, type: 'text/plain', file: b }),
    ]);
    const { items } = partitionDroppedItems(event, () => '/work/dir');
    // "a.txt, dir/, b.txt" must not collapse into the folder-first grouping.
    expect(items).toEqual([
      { kind: 'file', file: a },
      { kind: 'folder', path: '/work/dir' },
      { kind: 'file', file: b },
    ]);
  });

  it('drops unresolvable folders entirely instead of uploading them', () => {
    // No bridge (web): the folder yields no path AND must not land in files.
    const dir = fakeItem({ isDirectory: true });
    const { files, folderPaths } = partitionDroppedItems(fakeDragEvent([dir]), () => null);
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });

  it('skips non-file items for both sides', () => {
    const stringItem = fakeItem({ kind: 'string', type: 'text/plain' });
    const { files, folderPaths } = partitionDroppedItems(fakeDragEvent([stringItem]), () => '/x');
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });

  it('falls back to dataTransfer.files when the item list is empty', () => {
    const png = new File(['x'], 'a.png');
    const event = { dataTransfer: { items: [], files: [png] } } as unknown as DragEvent;
    const { files, folderPaths } = partitionDroppedItems(event, () => '/x');
    expect(files).toEqual([png]);
    expect(folderPaths).toEqual([]);
  });
});

function fakeClipboard(items: DataTransferItem[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

describe('partitionPastedItems', () => {
  it('splits pasted plain files from folders, resolving folder paths', () => {
    const png = new File(['x'], 'a.png');
    const dirFile = new File([], 'dir');
    const cd = fakeClipboard(
      [
        fakeItem({ isDirectory: false, type: 'image/png', file: png }),
        fakeItem({ isDirectory: true, file: dirFile }),
      ],
      [png, dirFile],
    );
    const { files, folderPaths } = partitionPastedItems(cd, () => '/work/dir');
    expect(files).toEqual([png]);
    expect(folderPaths).toEqual(['/work/dir']);
  });

  it('drops an unresolvable pasted folder entirely instead of uploading its stub', () => {
    // The reported bug: copy a folder in the file manager and paste it — with
    // no bridge (web) the stub must reach neither the draft nor the upload.
    const dirFile = new File([], 'dir');
    const cd = fakeClipboard([fakeItem({ isDirectory: true, file: dirFile })], [dirFile]);
    const { files, folderPaths } = partitionPastedItems(cd, () => null);
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });

  it('reports hasFolders even when no path resolves, so the caller can swallow the default paste', () => {
    // Otherwise a clipboard carrying the folder + its name as text/plain would
    // paste the bare name into the draft — the folder must be ignored fully.
    const unresolved = fakeItem({ isDirectory: true });
    expect(partitionPastedItems(fakeClipboard([unresolved]), () => null).hasFolders).toBe(true);

    const resolved = fakeItem({ isDirectory: true });
    expect(partitionPastedItems(fakeClipboard([resolved]), () => '/work/dir').hasFolders).toBe(true);

    const plain = fakeItem({ isDirectory: false, type: 'image/png' });
    const stringItem = fakeItem({ kind: 'string', type: 'text/plain' });
    expect(partitionPastedItems(fakeClipboard([plain, stringItem]), () => '/x').hasFolders).toBe(false);
    expect(partitionPastedItems(fakeClipboard([]), () => '/x').hasFolders).toBe(false);
  });

  it('excludes the folder stub from dataTransfer.files and de-duplicates across both lists', () => {
    const png = new File(['x'], 'a.png');
    const dirFile = new File([], 'dir');
    // The same folder stub shows up in both lists; only the items list still
    // carries the directory marker.
    const cd = fakeClipboard(
      [fakeItem({ isDirectory: true, file: dirFile }), fakeItem({ isDirectory: false, type: 'image/png', file: png })],
      [dirFile, png],
    );
    const { files } = partitionPastedItems(cd, () => '/work/dir');
    expect(files).toEqual([png]);
  });

  it('keeps screenshots that only appear in dataTransfer.files', () => {
    const shot = new File(['x'], 'image.png', { type: 'image/png' });
    const { files, folderPaths } = partitionPastedItems(fakeClipboard([], [shot]), () => null);
    expect(files).toEqual([shot]);
    expect(folderPaths).toEqual([]);
  });

  it('skips non-file items (e.g. copied text)', () => {
    const stringItem = fakeItem({ kind: 'string', type: 'text/plain' });
    const { files, folderPaths } = partitionPastedItems(fakeClipboard([stringItem]), () => '/x');
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });

  it('handles a directory item whose File is unavailable', () => {
    const noFile = fakeItem({ isDirectory: true, file: null });
    const { files, folderPaths } = partitionPastedItems(fakeClipboard([noFile]), () => '/x');
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });

  it('keeps the clipboard item order interleaved across folders and files (both are document pills now)', () => {
    const a = new File(['x'], 'a.txt');
    const dirFile = new File([], 'dir');
    const b = new File(['y'], 'b.txt');
    const cd = fakeClipboard([
      fakeItem({ isDirectory: false, type: 'text/plain', file: a }),
      fakeItem({ isDirectory: true, file: dirFile }),
      fakeItem({ isDirectory: false, type: 'text/plain', file: b }),
    ]);
    const { items } = partitionPastedItems(cd, () => '/work/dir');
    // "a.txt, dir/, b.txt" must not collapse into the folder-first grouping.
    expect(items).toEqual([
      { kind: 'file', file: a },
      { kind: 'folder', path: '/work/dir' },
      { kind: 'file', file: b },
    ]);
  });

  it('de-duplicates folders resolving to the same path', () => {
    const a = fakeItem({ isDirectory: true, file: new File([], 'a') });
    const b = fakeItem({ isDirectory: true, file: new File([], 'b') });
    const { folderPaths } = partitionPastedItems(fakeClipboard([a, b]), () => '/work/dir');
    expect(folderPaths).toEqual(['/work/dir']);
  });

  it('defaults to the desktop bridge and returns empty without one', () => {
    const dir = fakeItem({ isDirectory: true });
    setBridge({ getPathForFile: () => '/work/dir' });
    expect(partitionPastedItems(fakeClipboard([dir])).folderPaths).toEqual(['/work/dir']);

    setBridge(undefined);
    const { files, folderPaths } = partitionPastedItems(fakeClipboard([dir]));
    expect(files).toEqual([]);
    expect(folderPaths).toEqual([]);
  });
});
