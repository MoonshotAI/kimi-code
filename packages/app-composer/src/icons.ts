// packages/app-composer/src/icons.ts
// The glyphs the composer's DOM layers draw, pulled from the SAME source the
// app-client icon registry uses (kimi local svg dir + Remix `ri/*` line icons,
// via the unplugin-icons virtual modules) — so a glyph redraw in the design
// system lands here too instead of drifting from an inlined copy. file/folder/
// skill are the mention content type's own vocabulary; copy/check/external-
// link are the tooltip bubble's action glyphs; target/file-edit/close are the
// work-mode pill's mode glyphs and its dismiss ×. The size wrapper mirrors the
// registry's iconSvg (class + width/height + aria-hidden, sm/md/lg scale).
import RawFile from '~icons/kimi/file?raw';
import RawFolderOpen from '~icons/kimi/folder-open?raw';
import RawSparklingLine from '~icons/ri/sparkling-line?raw';
import RawCopy from '~icons/kimi/copy?raw';
import RawCheck from '~icons/kimi/check?raw';
import RawExternalLinkLine from '~icons/ri/external-link-line?raw';
import RawTarget from '~icons/kimi/target?raw';
import RawEdit from '~icons/kimi/edit?raw';
import RawClose from '~icons/kimi/close?raw';
import RawAttachment2 from '~icons/ri/attachment-2?raw';
import RawChatQuoteLine from '~icons/ri/chat-quote-line?raw';

type IconName = 'file' | 'folder' | 'skill' | 'copy' | 'check' | 'external-link' | 'target' | 'file-edit' | 'close' | 'attachment' | 'quote';
type IconSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

const RAW: Record<IconName, string> = {
  file: RawFile,
  folder: RawFolderOpen,
  skill: RawSparklingLine,
  copy: RawCopy,
  check: RawCheck,
  'external-link': RawExternalLinkLine,
  target: RawTarget,
  'file-edit': RawEdit,
  close: RawClose,
  attachment: RawAttachment2,
  quote: RawChatQuoteLine,
};

/** Render one of the mention icons to a sized <svg> string (v-html contexts). */
export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const px = SIZE_PX[size];
  return RAW[name]
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg class="kw-icon" width="${px}" height="${px}" aria-hidden="true"`);
}
