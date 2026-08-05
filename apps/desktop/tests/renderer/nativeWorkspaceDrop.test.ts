import { afterEach, describe, expect, it } from 'vitest';

import {
  canDropWorkspaceFolders,
  extractDroppedFolderPaths,
  looksLikeFolderDrag,
  partitionDroppedItems,
} from '../../src/renderer/lib/nativeWorkspaceDrop';

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
