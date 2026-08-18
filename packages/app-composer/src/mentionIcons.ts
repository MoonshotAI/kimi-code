// packages/app-composer/src/mentionIcons.ts
// Icon selection for @-mention entries and pills — one mapping shared by the
// mention menu rows (MentionMenu.vue) and the ProseMirror pill NodeView
// (composerEditor.ts), so a file looks the same in the menu and in the text.
import { iconSvg } from './icons';
import type { MentionKind } from './composerTextDoc';

// File-type glyphs: small line-SVG icons (viewBox 0 0 16 16). One folded-corner
// file glyph for every file (no per-extension code/doc/image variants), one
// folder glyph for folders. Subtle + muted; never an emoji.
const ICON_FOLDER = iconSvg('folder', 'sm');
const ICON_FILE = iconSvg('file', 'sm');
const ICON_SKILL = iconSvg('skill', 'sm');

/** Raw SVG string for a file/folder mention. The folder glyph wins when the
 *  caller already resolved the kind (the daemon's `kind` field), with the
 *  trailing-slash convention as fallback; every file gets the same glyph. */
export function fileMentionIconSvg(path: string, name?: string, isFolder?: boolean): string {
  if (isFolder || path.endsWith('/')) return ICON_FOLDER;
  return ICON_FILE;
}

/** Raw SVG string for any mention kind (skills get the sparkles glyph). */
export function mentionIconSvg(kind: MentionKind, path: string, name: string): string {
  if (kind === 'skill') return ICON_SKILL;
  return fileMentionIconSvg(path, name, kind === 'folder');
}
