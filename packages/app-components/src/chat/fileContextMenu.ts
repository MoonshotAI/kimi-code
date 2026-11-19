import { reactive } from 'vue';
import { absoluteFilePath } from '../lib/displayPath';

export interface FileContextMenuState {
  open: boolean;
  x: number;
  y: number;
  path: string;
  kind: 'file' | 'folder';
  cwd?: string;
  deleted: boolean;
  symlink: boolean;
}

const state = reactive<FileContextMenuState>({ open: false, x: 0, y: 0, path: '', kind: 'file', deleted: false, symlink: false });

export function useFileContextMenuState(): FileContextMenuState {
  return state;
}

export function closeFileContextMenu(): void {
  state.open = false;
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

export function resolveFileMenuPath(path: string, cwd?: string): string {
  return absoluteFilePath({ path, cwd });
}

function fileMenuTarget(el: Element): { path: string; kind: 'file' | 'folder'; symlink: boolean } | null {
  const direct = el.closest('[data-file-path]');
  if (direct !== null) {
    const path = direct.getAttribute('data-file-path') ?? '';
    if (path === '') return null;
    const kind = direct.getAttribute('data-file-kind') === 'folder' ? 'folder' : 'file';
    return { path, kind, symlink: direct.hasAttribute('data-file-symlink') };
  }
  const pill = el.closest('.mention-pill');
  if (pill !== null && pill.closest('.ProseMirror') === null) {
    const kind = pill.getAttribute('data-mention-kind');
    if (kind !== null && kind !== 'file' && kind !== 'folder') return null;
    const path = pill.getAttribute('data-mention-action-path') ?? pill.getAttribute('data-mention-path') ?? '';
    if (path === '') return null;
    return { path, kind: kind === 'folder' ? 'folder' : 'file', symlink: false };
  }
  return null;
}

export function openFileContextMenu(event: MouseEvent, cwd?: string): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const hit = fileMenuTarget(target);
  if (hit === null) return;
  event.preventDefault();
  event.stopPropagation();
  state.x = event.clientX;
  state.y = event.clientY;
  state.path = hit.path;
  state.kind = hit.kind;
  state.cwd = cwd;
  state.deleted = target.closest('[data-file-deleted]') !== null;
  state.symlink = hit.symlink;
  state.open = true;
}
