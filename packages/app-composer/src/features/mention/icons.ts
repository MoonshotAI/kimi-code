import { iconSvg } from '../../shared/icons';
import type { MentionKind } from '../../model';

const ICON_FOLDER = iconSvg('folder', 'sm');
const ICON_FILE = iconSvg('file', 'sm');
const ICON_SKILL = iconSvg('skill', 'sm');
const ICON_SESSION = iconSvg('session', 'sm');

export function fileMentionIconSvg(path: string, name?: string, isFolder?: boolean): string {
  if (isFolder || path.endsWith('/')) return ICON_FOLDER;
  return ICON_FILE;
}

export function mentionIconSvg(kind: MentionKind, path: string, name: string): string {
  if (kind === 'skill') return ICON_SKILL;
  if (kind === 'session') return ICON_SESSION;
  return fileMentionIconSvg(path, name, kind === 'folder');
}
