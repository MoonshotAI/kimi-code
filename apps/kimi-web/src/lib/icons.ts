// apps/kimi-web/src/lib/icons.ts
// Single source of truth for apps/kimi-web line icons (design-system §02).
//
// Icons are line glyphs: stroke="currentColor", stroke-width 1.5, round caps/joins,
// no fill — colour follows text. Most sit on a 16x16 grid; a few keep a different
// source grid (24x24 for settings / expand / collapse / panel-* / git-pull-request /
// star-*, 12x12 for info, 20x20 for image-off / file-off). The rendered size is always
// the token size, and the global `.kw-icon * { vector-effect: non-scaling-stroke }` rule
// (style.css) keeps the 1.5px stroke visually identical across grids.
//
// Two consumers share this registry:
//   - the <Icon> Vue component (components/ui/Icon.vue) for template use;
//   - iconSvg() below, for v-html contexts (e.g. lib/toolMeta.ts).

export type IconSize = 'sm' | 'md' | 'lg';

export interface IconDef {
  /** Inner SVG markup only — no outer <svg>, no stroke/fill attributes (the
   *  renderer adds those). Mixed icons may override fill on individual shapes. */
  body: string;
  /** Source grid. Defaults to "0 0 16 16". */
  viewBox?: string;
  /** Solid icon (fill="currentColor", no stroke). Defaults to line style. */
  fill?: boolean;
}

export const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

export const ICONS = {
  // --- Actions (16-grid, line) --------------------------------------------
  plus: { body: '<path d="M8 3v10M3 8h10"/>' },
  close: { body: '<path d="M4 4l8 8M12 4l-8 8"/>' },
  check: { body: '<path d="M3 8.5l3.5 3.5L13 4.5"/>' },
  search: { body: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>' },
  folder: {
    body: '<path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/><path d="M1 5.5h12"/>',
  },
  image: {
    body: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.2"/><path d="M2 10.5l3-2.5L8 11l2.5-2L14 11"/>',
  },
  'chevron-down': { body: '<path d="M4 6l4 4 4-4"/>' },
  send: { body: '<path d="M8 3l6 5.5M8 3L2 8.5M8 3v10"/>' },
  sort: { body: '<path d="M3 4h10M3 8h7M3 12h4"/>' },
  grip: {
    body: '<circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/>',
    fill: true,
  },

  // --- Tool glyphs (16-grid, line) ----------------------------------------
  'file-text': {
    body: '<rect x="2.5" y="1.5" width="9" height="13" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="7.5" x2="11" y2="7.5"/><line x1="5" y1="10" x2="10" y2="10"/>',
  },
  terminal: {
    body: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><polyline points="4,6 6.5,8 4,10"/><line x1="8" y1="10" x2="12" y2="10"/>',
  },
  pencil: {
    body: '<path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z"/><line x1="8.5" y1="4.5" x2="11.5" y2="7.5"/>',
  },
  'file-plus': {
    body: '<path d="M3 12V4.5L8 2l5 2.5V12H3z"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="8" y1="5" x2="8" y2="9"/>',
  },
  glob: {
    body: '<path d="M5 2.5C3.5 2.5 3.5 5 3.5 6.5S2.5 8 2.5 8s1 0 1 1.5S3.5 13.5 5 13.5"/><path d="M11 2.5c1.5 0 1.5 2.5 1.5 4S13.5 8 13.5 8s-1 0-1 1.5.5 4-1.5 4"/><line x1="8" y1="6" x2="8" y2="10"/><line x1="6.3" y1="6.8" x2="9.7" y2="9.2"/><line x1="9.7" y1="6.8" x2="6.3" y2="9.2"/>',
  },
  globe: {
    body: '<circle cx="8" cy="8" r="6"/><path d="M8 2c-2 2-3 3.6-3 6s1 4 3 6"/><path d="M8 2c2 2 3 3.6 3 6s-1 4-3 6"/><line x1="2" y1="8" x2="14" y2="8"/>',
  },
  'check-list': {
    body: '<polyline points="2,4.5 3.5,6 5.5,3"/><polyline points="2,11 3.5,12.5 5.5,9.5"/><line x1="8" y1="4.5" x2="14" y2="4.5"/><line x1="8" y1="11" x2="14" y2="11"/>',
  },
  bolt: { body: '<path d="M8.5 1L3 9h4l-1.5 6 5.5-8h-4l1.5-6z"/>' },

  // --- 24-grid line icons -------------------------------------------------
  'panel-collapse': {
    viewBox: '0 0 24 24',
    body: '<path d="M11 6h9"/><path d="M11 12h9"/><path d="M11 18h9"/><path d="M7 9l-3 3 3 3"/>',
  },
  settings: {
    viewBox: '0 0 24 24',
    body: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/>',
  },
  expand: {
    viewBox: '0 0 24 24',
    body: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  },
  collapse: {
    viewBox: '0 0 24 24',
    body: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  },

  // --- Mixed / solid ------------------------------------------------------
  info: {
    viewBox: '0 0 12 12',
    body: '<circle cx="6" cy="6" r="5"/><line x1="6" y1="3.5" x2="6" y2="6.5"/><circle cx="6" cy="8.5" r="0.5" fill="currentColor"/>',
  },
  play: { body: '<path d="M5 3.5v9l7-4.5z"/>', fill: true },
  stop: { body: '<rect x="3" y="3" width="10" height="10" rx="1.5"/>', fill: true },
  star: {
    viewBox: '0 0 24 24',
    body: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    fill: true,
  },

  // --- More actions (16-grid, line) ---------------------------------------
  'log-in': {
    body: '<path d="M6 3h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6"/><path d="M9 8H2"/><path d="M5 5l3 3-3 3"/>',
  },
  message: {
    body: '<path d="M4 2.5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.5l-2.5 2V11.5H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z"/>',
  },
  mail: {
    body: '<path d="M2 4l6 4 6-4"/><rect x="2" y="4" width="12" height="8" rx="1.5"/>',
  },
  code: {
    body: '<polyline points="5.5,5 2.5,8 5.5,11"/><polyline points="10.5,5 13.5,8 10.5,11"/>',
  },
  file: {
    body: '<path d="M4 1.5h5l3 3v10H4z"/><polyline points="9,1.5 9,4.5 12,4.5"/>',
  },
  copy: {
    body: '<rect x="3" y="3" width="9" height="9" rx="1.5"/><path d="M6 1h7a1 1 0 0 1 1 1v7"/>',
  },
  link: {
    body: '<path d="M6.5 9.5a3 3 0 0 0 4.2.3l2-2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.5 6.5a3 3 0 0 0-4.2-.3l-2 2a3 3 0 0 0 4.2 4.2l1-1"/>',
  },
  'external-link': {
    body: '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 7.5 8.5"/><path d="M12 8.7V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5.5A1.5 1.5 0 0 1 4 4h3.3"/>',
  },
  download: {
    body: '<path d="M8 2v8"/><path d="M4.5 6.5 8 10l3.5-3.5"/><path d="M2.5 13.5h11"/>',
  },
  undo: {
    body: '<path d="M6.5 2.5 3 6l3.5 3.5"/><path d="M3 6h6.5a3.8 3.8 0 1 1 0 7.6H7.5"/>',
  },
  clock: {
    body: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  },
  sparkles: {
    body: '<path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z"/>',
  },
  list: { body: '<path d="M2 4h12M2 8h12M2 12h8"/>' },
  user: {
    body: '<circle cx="8" cy="5" r="3"/><path d="M3 14c0-3 2.2-5 5-5s5 2 5 5"/>',
  },
  'folder-plus': {
    body: '<path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/><path d="M1 5.5h12"/><path d="M8 7.25v4.5M5.75 9.5h4.5"/>',
  },
  'folder-closed': {
    body: '<path d="M1.5 6V3.5a1 1 0 0 1 1-1h3.6l1.3 1.5h5.1a1 1 0 0 1 1 1v1"/><rect x="1.5" y="6" width="13" height="7" rx="1"/>',
  },

  // --- Navigation & arrows (16-grid, line) --------------------------------
  'chevron-right': { body: '<path d="M6 4l4 4-4 4"/>' },
  'arrow-up': { body: '<path d="M8 12V4M4 7l4-3 4 3"/>' },
  'arrow-down': { body: '<path d="M8 4v8m0 0 3.5-3.5M8 12l-3.5-3.5"/>' },
  'arrow-right': { body: '<path d="M2 8h10"/><path d="M8 4l4 4-4 4"/>' },
  minus: { body: '<path d="M3 8h10"/>' },

  // --- More 24-grid line icons --------------------------------------------
  'panel-expand': {
    viewBox: '0 0 24 24',
    body: '<path d="M4 6h9"/><path d="M4 12h9"/><path d="M4 18h9"/><path d="M17 9l3 3-3 3"/>',
  },
  'git-pull-request': {
    viewBox: '0 0 24 24',
    body: '<circle cx="5" cy="6" r="3"/><path d="M5 9v12"/><circle cx="19" cy="18" r="3"/><path d="m15 9-3-3 3-3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/>',
  },
  sliders: {
    viewBox: '0 0 24 24',
    body: '<line x1="4" y1="8" x2="20" y2="8"/><circle cx="10" cy="8" r="2.5" fill="currentColor"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.5" fill="currentColor"/>',
  },
  'star-outline': {
    viewBox: '0 0 24 24',
    body: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  },


  // --- Mixed / solid ------------------------------------------------------
  'alert-triangle': {
    body: '<path d="M8 2 14 13H2L8 2Z"/><path d="M8 6v3"/><circle cx="8" cy="11" r=".6" fill="currentColor"/>',
  },
  'help-circle': {
    body: '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6a1.8 1.8 0 0 1 3.5.6c0 1.2-1.7 1.4-1.7 2.6"/><circle cx="8" cy="11.5" r=".7" fill="currentColor"/>',
  },
  'dots-vertical': {
    body: '<circle cx="8" cy="3" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="13" r="1.3"/>',
    fill: true,
  },
  'dots-horizontal': {
    body: '<circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/>',
    fill: true,
  },
  'folder-solid': {
    body: '<path d="M1.5 3.5h3l1.5 2h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/>',
    fill: true,
  },

  // --- Placeholders (20-grid, line) ---------------------------------------
  'image-off': {
    viewBox: '0 0 20 20',
    body: '<rect x="2" y="2" width="16" height="16" rx="2"/><path d="M7 10h6M10 7v6"/>',
  },
  'file-off': {
    viewBox: '0 0 20 20',
    body: '<path d="M5 3h7l4 4v10H5V3z"/><path d="M12 3v4h4"/>',
  },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

const DEFAULT_VIEWBOX = '0 0 16 16';

/** Typed accessor: `ICONS[name]` is a narrow literal union (some entries lack
 *  optional fields), so we widen to IconDef here — safe because the registry
 *  is `satisfies Record<string, IconDef>`. */
export function getIcon(name: IconName): IconDef {
  return ICONS[name] as IconDef;
}

/** Render an icon to a full <svg> string for v-html contexts. Mirrors <Icon>. */
export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const def = getIcon(name);
  const px = SIZE_PX[size];
  const viewBox = def.viewBox ?? DEFAULT_VIEWBOX;
  if (def.fill) {
    return `<svg class="kw-icon" width="${px}" height="${px}" viewBox="${viewBox}" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${def.body}</svg>`;
  }
  return `<svg class="kw-icon" width="${px}" height="${px}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${def.body}</svg>`;
}
