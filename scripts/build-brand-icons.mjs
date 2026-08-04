#!/usr/bin/env node
// build-brand-icons.mjs — regenerate every brand icon resource from the
// designer-owned KIMI CODE LOGO/ kit (repo root). Run after any brand refresh:
//
//   pnpm build:icons
//
// Kit inputs (all under KIMI CODE LOGO/):
//   White Background.png / .svg — light tile + robot mark (app icon source)
//   All White.png              — mark alone, solid white (tray silhouette)
//   Original Logo.png / .svg   — colored mark alone, transparent bg
//
// Outputs:
//   apps/desktop/build/icon.png   512² Linux/dev-Dock icon
//   apps/desktop/build/icon-dark.png  512² dark-tile Dock variant (runtime theme swap)
//   apps/desktop/build/icon.ico   7 frames (16–256), Windows
//   apps/desktop/build/icon.icns  10-entry iconset via iconutil (macOS only)
//   apps/desktop/build/tray.png, tray@2x.png         Linux tray (white silhouette)
//   apps/desktop/build/trayTemplate.png, trayTemplate@2x.png  macOS menu-bar template
//   apps/desktop/build/tray.ico   4 frames (16–48), Windows tray (white tile)
//   Inline brand marks between `brand-mark:start/end` comments in:
//     apps/desktop/src/renderer/components/onboarding/BrandLogo.vue
//     apps/desktop/src/renderer/components/Sidebar.vue
//
// NOTE: apps/web is intentionally NOT an output. The web UI forked its brand
// back to the legacy "little blue" mark (sidebar, onboarding, favicon) — do
// not re-add web targets here, or the next run clobbers that fork.
//
// Geometry decisions (do not change casually — they keep the icon consistent
// with macOS conventions and the pre-refresh assets):
//   - macOS/Linux app icon: the tile occupies 414/512 of the canvas (49px
//     margin per side at 512, i.e. Apple's 824/1024 icon grid) so the Dock icon
//     reads normal-sized next to other apps.
//   - Windows app icon is full-bleed. Explorer already allocates the icon
//     canvas; reusing the Apple inset there makes the shortcut visibly smaller
//     than neighboring Windows apps.
//   - Tile corners are a baked macOS squircle (superellipse n=4.5, ~1.5px AA),
//     so pre-Tahoe macOS (no system masking) still shows a rounded icon; Tahoe
//     re-clips the already-transparent corners to the same shape.
//   - App icons rasterize from the kit's SVG vectors (White/Black Background)
//     for full sharpness; the kit PNGs are only previews and tray sources.
//   - Tray silhouette: mark fit into a 16px box centered on a 22px canvas
//     (44/32 at @2x) — pixel-exact match of the original assets.
//   - tray.png is intentionally the same white silhouette as the template
//     (status quo; tray.ts comments call it "color" but the shipped asset was
//     always white — revisit deliberately, not here).
//
// Requires the `sharp` devDependency. No network access; iconutil is invoked
// only on macOS (the script FAILS elsewhere — a partial icon set is worse
// than none).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'KIMI CODE LOGO');
const BUILD = path.join(ROOT, 'apps', 'desktop', 'build');

const SQUIRCLE_N = 4.5; // superellipse exponent ≈ Apple's continuous corner
const MASK_FEATHER_PX = 1.5; // antialias width on the squircle edge
const ICON_MARGIN = 49 / 512; // transparent margin fraction (Apple 824/1024 grid)
const ICO_HEADER = 6;
const ICO_ENTRY = 16;

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is required — run `pnpm install` first.');
  process.exit(1);
}

const written = [];
function save(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  written.push(path.relative(ROOT, file));
}

// ---------------------------------------------------------------------------
// Raster helpers
// ---------------------------------------------------------------------------

/** Squircle alpha mask (Uint8Array, 0–255) for a size×size tile. */
function squircleMask(size) {
  const half = size / 2;
  const cov = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = Math.abs((y + 0.5 - half) / half) ** SQUIRCLE_N;
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5 - half) / half) ** SQUIRCLE_N;
      const d = 1 - (u + v) ** (1 / SQUIRCLE_N); // ~signed distance, half-width units
      cov[y * size + x] = Math.round(Math.min(Math.max(d * (half / MASK_FEATHER_PX) + 0.5, 0), 1) * 255);
    }
  }
  return cov;
}

/** Apply an alpha mask (0–255 per pixel) to an RGBA image buffer. */
async function applyMask(pngBuf, size) {
  const raw = Buffer.alloc(size * size * 4);
  const cov = squircleMask(size);
  for (let i = 0; i < cov.length; i++) {
    raw[i * 4] = raw[i * 4 + 1] = raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = cov[i];
  }
  const maskPng = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  return sharp(pngBuf).ensureAlpha().composite([{ input: maskPng, blend: 'dest-in' }]).png().toBuffer();
}

/** Multi-frame ICO with PNG-compressed frames (Vista+ standard). */
function icoBuffer(framePngs, sizes) {
  const offsetBase = ICO_HEADER + ICO_ENTRY * sizes.length;
  const header = Buffer.alloc(ICO_HEADER);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(ICO_ENTRY * sizes.length);
  let offset = offsetBase;
  sizes.forEach((s, i) => {
    const at = i * ICO_ENTRY;
    entries.writeUInt8(s >= 256 ? 0 : s, at);
    entries.writeUInt8(s >= 256 ? 0 : s, at + 1);
    entries.writeUInt8(0, at + 2);
    entries.writeUInt8(0, at + 3);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(framePngs[i].length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += framePngs[i].length;
  });
  return Buffer.concat([header, entries, ...framePngs]);
}

/** Fit `img` (w×h) inside a box, centered on a square transparent canvas. */
async function fitOnCanvas(img, w, h, canvas, box) {
  const r = Math.min(box / w, box / h);
  const rw = Math.round(w * r);
  const rh = Math.round(h * r);
  const scaled = await sharp(img).resize(rw, rh, { kernel: 'lanczos3' }).png().toBuffer();
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaled, left: Math.floor((canvas - rw) / 2), top: Math.floor((canvas - rh) / 2) }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// App icons: icon.png / icon.icns (inset squircle) + icon.ico / favicon (full-bleed)
// ---------------------------------------------------------------------------

/** Rasterize a kit tile SVG onto a `bgColor` field at `size`². The vector is
 *  the quality source (the kit PNGs are small previews); flatten also covers
 *  the tile rect's sub-pixel inset (119.647/120 in the current kit). */
async function rasterizeTile(svgPath, bgColor, size) {
  const meta = await sharp(svgPath).metadata();
  return sharp(svgPath, { density: 72 * (size / meta.width) })
    .flatten({ background: bgColor })
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/** Kit tile SVG -> squircle-masked tile inset on a transparent canvas (Apple
 *  824/1024 grid). Returns the full-size canvas PNG buffer. */
async function composeIconCanvas(svgPath, bgColor) {
  const C = 2712; // master composition size; every output downscales from it
  const margin = Math.round(C * ICON_MARGIN);
  const T = C - 2 * margin;
  const field = await rasterizeTile(svgPath, bgColor, C);
  const tileRaw = await sharp(field).resize(T, T, { kernel: 'lanczos3' }).png().toBuffer();
  const tile = await applyMask(tileRaw, T);
  return sharp({
    create: { width: C, height: C, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: tile, left: margin, top: margin }])
    .png()
    .toBuffer();
}

async function buildAppIcons() {
  // Fail fast on non-macOS: iconutil (icon.icns) only exists there, and
  // writing the other outputs first would leave a partially refreshed set.
  if (process.platform !== 'darwin') {
    throw new Error('icon.icns can only be regenerated on macOS (iconutil) — re-run `pnpm build:icons` on a Mac before committing.');
  }
  const src = path.join(KIT, 'White Background.svg');
  const canvas = await composeIconCanvas(src, '#ffffff');
  const resize = (s) => sharp(canvas).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer();

  save(path.join(BUILD, 'icon.png'), await resize(512));

  // Dark-mode Dock variant (runtime swap in src/main/dock-icon.ts): same
  // composition from the kit's Black Background tile. 512² png only — it is
  // not part of the packaged .icns (macOS has no appearance variants there).
  const darkCanvas = await composeIconCanvas(path.join(KIT, 'Black Background.svg'), '#000000');
  save(
    path.join(BUILD, 'icon-dark.png'),
    await sharp(darkCanvas).resize(512, 512, { kernel: 'lanczos3' }).png().toBuffer(),
  );

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const full = await applyMask(await rasterizeTile(src, '#ffffff', 2712), 2712);
  const resizeFull = (s) => sharp(full).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer();
  save(path.join(BUILD, 'icon.ico'), icoBuffer(await Promise.all(icoSizes.map(resizeFull)), icoSizes));

  // iconset -> iconutil -> icns (the up-front guard above ensures darwin)
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-icon-')) + '/icon.iconset';
  fs.mkdirSync(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(`${iconset}/icon_${base}x${base}.png`, await resize(base));
    fs.writeFileSync(`${iconset}/icon_${base}x${base}@2x.png`, await resize(base * 2));
  }
  const icnsOut = path.join(BUILD, 'icon.icns');
  const res = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icnsOut], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('iconutil failed');
  written.push(path.relative(ROOT, icnsOut));
}

// ---------------------------------------------------------------------------
// Tray icons
// ---------------------------------------------------------------------------

async function buildTrayIcons() {
  // White silhouette: mark fit into a 16px box on a 22px canvas (32 on 44 @2x).
  const aw = await sharp(path.join(KIT, 'All White.png')).png().toBuffer();
  const { width: awW, height: awH } = await sharp(aw).metadata();
  for (const [canvas, box] of [[22, 16], [44, 32]]) {
    const png = await fitOnCanvas(aw, awW, awH, canvas, box);
    const suffix = canvas === 22 ? '' : '@2x';
    save(path.join(BUILD, `trayTemplate${suffix}.png`), png);
    save(path.join(BUILD, `tray${suffix}.png`), png);
  }

  // Windows tray: full-bleed white tile.
  const sizes = [16, 24, 32, 48];
  const full = await applyMask(
    await rasterizeTile(path.join(KIT, 'White Background.svg'), '#ffffff', 512),
    512,
  );
  const frames = await Promise.all(
    sizes.map((s) => sharp(full).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer()),
  );
  save(path.join(BUILD, 'tray.ico'), icoBuffer(frames, sizes));
}

// ---------------------------------------------------------------------------
// Inline component brand marks (SVG path scaling + marker splice)
// ---------------------------------------------------------------------------

const fmt = (x) => {
  const s = x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

/** Scale an SVG path's absolute M/L/C/H/Z coordinates by `s`. */
function scalePath(d, s) {
  const tokens = d.match(/[MLCHZmlchz]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  const out = [];
  let cmd = null;
  for (const t of tokens) {
    if (/^[MLCHZ]$/i.test(t)) {
      cmd = t.toUpperCase();
      out.push(t);
    } else if (/^[-\d.]/.test(t)) {
      if (cmd === null || cmd === 'Z') throw new Error(`malformed path: ${d.slice(0, 40)}…`);
      out.push(fmt(parseFloat(t) * s));
    } else {
      throw new Error(`unsupported path command in: ${d.slice(0, 40)}…`);
    }
  }
  return out.join(' ');
}

/** Parse a kit SVG: 7 mark paths (head ×2, eyes ×2, chevron, dash, dot), the
 *  terminal bar rect (fill="#002E58"), and the face radialGradient transform. */
function parseKitSvg(file) {
  const src = fs.readFileSync(file, 'utf8');
  const paths = [...src.matchAll(/<path\s+([^>]*?)\s*\/?>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
  if (paths.length !== 7) throw new Error(`${path.basename(file)}: expected 7 paths, got ${paths.length}`);
  const rects = [...src.matchAll(/<rect\s+([^>]*?)\s*\/?>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
  const term = rects.find((r) => r.fill === '#002E58');
  if (!term) throw new Error(`${path.basename(file)}: terminal bar rect not found`);
  const grad = src.match(/gradientTransform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/);
  if (!grad) throw new Error(`${path.basename(file)}: face gradientTransform not found`);
  const vb = src.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error(`${path.basename(file)}: viewBox not found`);
  return { paths, term, grad, vbW: parseFloat(vb[1]), vbH: parseFloat(vb[2]) };
}

/** Shared inner markup for both component marks. */
function markInner(kit, s, { gradIdAttr, gradFillAttr, chevronStroke, indent }) {
  const sp = kit.paths.map((p) => scalePath(p.d, s));
  const [gx, gy, gr] = [1, 2, 3].map((i) => fmt(parseFloat(kit.grad[i]) * s));
  const t = {
    x: fmt(parseFloat(kit.term.x ?? '0') * s),
    y: fmt(parseFloat(kit.term.y ?? '0') * s),
    w: fmt(parseFloat(kit.term.width) * s),
    h: fmt(parseFloat(kit.term.height) * s),
    rx: fmt(parseFloat(kit.term.rx) * s),
  };
  // Stroke widths come from the kit itself (paths 4/5) — do NOT hardcode: the
  // v1 kit used 20 at 678 units, the current one 3.52941 at 120.
  for (const i of [4, 5]) {
    if (!kit.paths[i]['stroke-width']) throw new Error(`kit path ${i}: stroke-width not found`);
  }
  const swChevron = fmt(parseFloat(kit.paths[4]['stroke-width']) * s);
  const swDash = fmt(parseFloat(kit.paths[5]['stroke-width']) * s);
  const i1 = indent;
  const i2 = indent + '  ';
  const i3 = indent + '    ';
  return [
    `${i1}<defs>`,
    `${i2}<radialGradient ${gradIdAttr} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${gx} ${gy}) scale(${gr})">`,
    `${i3}<stop stop-color="#117DFB" />`,
    `${i3}<stop offset="0.759254" stop-color="#449BFF" />`,
    `${i3}<stop offset="1" stop-color="#77B6FF" />`,
    `${i2}</radialGradient>`,
    `${i1}</defs>`,
    `${i1}<path d="${sp[0]}" fill="#2389FF" />`,
    `${i1}<path d="${sp[1]}" ${gradFillAttr} />`,
    `${i1}<g class="ch-eyes" fill="#fff">`,
    `${i2}<path class="ch-eye" d="${sp[2]}" />`,
    `${i2}<path class="ch-eye" d="${sp[3]}" />`,
    `${i1}</g>`,
    `${i1}<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${t.rx}" fill="#002E58" />`,
    `${i1}<path d="${sp[4]}" stroke="${chevronStroke}" stroke-width="${swChevron}" stroke-linecap="round" />`,
    `${i1}<path d="${sp[5]}" stroke="#007CFF" stroke-width="${swDash}" stroke-linecap="round" />`,
    `${i1}<path d="${sp[6]}" fill="#1783FF" />`,
  ];
}

/** Onboarding BrandLogo: White Background.svg at viewBox 120, tiles rounded
 *  22.5% (rx=27) to match the shipped icon's baked squircle. */
function genBrandLogo(kit) {
  const W = 120;
  const s = W / kit.vbW;
  const rx = fmt(0.225 * W);
  const inner = markInner(kit, s, {
    gradIdAttr: ':id="faceId"',
    gradFillAttr: ':fill="`url(#${faceId})`"',
    chevronStroke: 'white',
    indent: '    ',
  });
  return [
    '  <svg',
    '    ref="logoRef"',
    '    :class="[\'brand-logo\', `bl-variant-${variant}`]"',
    '    :style="{ width: `${size}px`, height: `${size}px` }"',
    `    viewBox="0 0 ${W} ${W}"`,
    '    fill="none"',
    '    xmlns="http://www.w3.org/2000/svg"',
    '    role="img"',
    '    aria-label="Kimi Code"',
    '    @click="blinkOnce"',
    '  >',
    `    <rect class="bl-tile bl-tile-light" width="${W}" height="${W}" rx="${rx}" fill="black" />`,
    `    <rect class="bl-tile bl-tile-dark" width="${W}" height="${W}" rx="${rx}" fill="white" />`,
    ...inner,
    '  </svg>',
  ].join('\n');
}

/** Sidebar .ch-logo: Original Logo.svg scaled to viewBox width 32 (kept ~32 so
 *  the shared px-based eye keyframes in style.css keep their proportions). */
function genSidebarLogo(kit) {
  const W = 32;
  const s = W / kit.vbW;
  const H = fmt(kit.vbH * s);
  const inner = markInner(kit, s, {
    gradIdAttr: 'id="chLogoFace"',
    gradFillAttr: 'fill="url(#chLogoFace)"',
    chevronStroke: '#fff',
    indent: '              ',
  });
  return [
    `            <svg ref="logoRef" class="ch-logo" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick" @pointerdown="onLogoPointerDown" @pointerup="onLogoPointerUp" @pointercancel="onLogoPointerUp">`,
    ...inner,
    '            </svg>',
  ].join('\n');
}

/** Replace the region between brand-mark markers in `file` with `block`. */
function spliceBrandMark(file, block, srcName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^([ \t]*)<!-- brand-mark:start/m);
  if (!m) throw new Error(`${path.relative(ROOT, file)}: brand-mark:start marker not found`);
  const indent = m[1];
  const start =
    `${indent}<!-- brand-mark:start — generated by scripts/build-brand-icons.mjs from\n` +
    `${indent}     KIMI CODE LOGO/${srcName}; do not edit by hand -->`;
  const re = /[ \t]*<!-- brand-mark:start[\s\S]*?<!-- brand-mark:end -->/;
  if (!re.test(src)) throw new Error(`${path.relative(ROOT, file)}: brand-mark region not found`);
  save(file, src.replace(re, `${start}\n${block}\n${indent}<!-- brand-mark:end -->`));
}

function buildComponentMarks() {
  const whiteKit = parseKitSvg(path.join(KIT, 'White Background.svg'));
  const originalKit = parseKitSvg(path.join(KIT, 'Original Logo.svg'));
  const brandLogo = genBrandLogo(whiteKit);
  const sidebarLogo = genSidebarLogo(originalKit);
  // Desktop only — apps/web forked its brand marks back to the legacy
  // "little blue"; do not re-add it here (see the header note).
  const app = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer');
  spliceBrandMark(path.join(app, 'components/onboarding/BrandLogo.vue'), brandLogo, 'White Background.svg');
  spliceBrandMark(path.join(app, 'components/Sidebar.vue'), sidebarLogo, 'Original Logo.svg');
}

// ---------------------------------------------------------------------------

await buildAppIcons();
await buildTrayIcons();
buildComponentMarks();
console.log('Regenerated brand resources:');
for (const f of written) console.log('  ✓', f);
