// packages/app-composer/src/icons.ts
// The six glyphs the mention feature draws, pulled from the SAME source the
// app-client icon registry uses (kimi local svg dir + Remix `ri/*` line icons,
// via the unplugin-icons virtual modules) — so a glyph redraw in the design
// system lands here too instead of drifting from an inlined copy. file/folder/
// skill are the mention content type's own vocabulary; copy/check/external-
// link are the tooltip bubble's action glyphs. The size wrapper mirrors the
// registry's iconSvg (class + width/height + aria-hidden, sm/md/lg scale).
import RawFile from '~icons/kimi/file?raw';
import RawFolderOpen from '~icons/kimi/folder-open?raw';
import RawSparklingLine from '~icons/ri/sparkling-line?raw';
import RawCopy from '~icons/kimi/copy?raw';
import RawCheck from '~icons/kimi/check?raw';
import RawExternalLinkLine from '~icons/ri/external-link-line?raw';

type IconName = 'file' | 'folder' | 'skill' | 'copy' | 'check' | 'external-link';
type IconSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

const RAW: Record<IconName, string> = {
  file: RawFile,
  folder: RawFolderOpen,
  skill: RawSparklingLine,
  copy: RawCopy,
  check: RawCheck,
  'external-link': RawExternalLinkLine,
};

/** Render one of the mention icons to a sized <svg> string (v-html contexts). */
export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const px = SIZE_PX[size];
  return RAW[name]
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg class="kw-icon" width="${px}" height="${px}" aria-hidden="true"`);
}
