// apps/kimi-web/src/lib/icons.ts
// Single source of truth for apps/kimi-web icons (design-system §02).
//
// Icons come from Remix Icon (https://remixicon.com/, Apache-2.0). The per-icon
// SVG data is generated into ./icon-data.ts by scripts/gen-icon-data.mjs — a
// tree-shaken subset of @iconify-json/ri — so the registry is library-sourced,
// offline, and only bundles the icons we actually use.
//
// Remix icons are fill-based (fill="currentColor") on a 24x24 source grid; the
// rendered size is always the token size. Colour follows text.
//
// Two consumers share this registry:
//   - the <Icon> Vue component (components/ui/Icon.vue) for template use;
//   - iconSvg() below, for v-html contexts (e.g. lib/toolMeta.ts).

import { iconToSVG } from '@iconify/utils';
import { ICON_DATA, type IconData, type IconName } from './icon-data';

export type { IconName } from './icon-data';
export { NAME_TO_REMIX } from './icon-data';

export type IconSize = 'sm' | 'md' | 'lg';

export const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

export interface IconDef {
  /** Inner SVG markup only — no outer <svg>. Remix icons are fill-based. */
  body: string;
  /** Source grid. Remix icons are "0 0 24 24". */
  viewBox?: string;
  /** Solid icon (fill="currentColor", no stroke). Always true for Remix. */
  fill?: boolean;
}

function viewBoxOf(d: IconData): string {
  return `0 0 ${d.width ?? 24} ${d.height ?? 24}`;
}

/** Back-compat registry view over the generated Remix data. */
export const ICONS: Record<IconName, IconDef> = Object.fromEntries(
  (Object.entries(ICON_DATA) as [IconName, IconData][]).map(([name, d]) => [
    name,
    { body: d.body, viewBox: viewBoxOf(d), fill: true },
  ]),
) as Record<IconName, IconDef>;

export function getIcon(name: IconName): IconDef {
  return ICONS[name];
}

/** Render an icon to a full <svg> string for v-html contexts. Mirrors <Icon>. */
export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const px = SIZE_PX[size];
  const svg = iconToSVG(ICON_DATA[name], { width: px, height: px });
  const viewBox = svg.attributes.viewBox;
  return `<svg class="kw-icon" width="${px}" height="${px}" viewBox="${viewBox}" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${svg.body}</svg>`;
}
