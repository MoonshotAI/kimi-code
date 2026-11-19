#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = path.join(ROOT, 'KIMI CODE LOGO');
const BUILD = path.join(ROOT, 'apps', 'desktop', 'build');

const ICON_CORNER_RATIO = 0.26;
const ICON_MARGIN = 100 / 1024;
const CONTINUOUS_CORNER = [1.52866483, 1.08849323, 0.86840689, 0.07491176, 0.63149399, 0.37282392, 0.16906013];
const ICO_HEADER = 6;
const ICO_ENTRY = 16;

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is required — run `pnpm -C scripts/icon-tools install` first.');
  process.exit(1);
}

const written = [];
function save(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  written.push(path.relative(ROOT, file));
}

function continuousSquarePath(size, radius) {
  const [a, b, c, d, e, f, g] = CONTINUOUS_CORNER;
  const r = Math.min(radius, size / 2 / a);
  const corners = [
    [size, 0, 1, 0, 0, 1],
    [size, size, 0, 1, -1, 0],
    [0, size, -1, 0, 0, -1],
    [0, 0, 0, -1, 1, 0],
  ];
  const segments = [
    [[b, 0], [c, 0], [e, d]],
    [[f, g], [g, f], [d, e]],
    [[0, c], [0, b], [0, a]],
  ];
  const parts = [];
  for (const [cx, cy, ix, iy, ox, oy] of corners) {
    const pt = ([u, v]) => `${(cx - u * r * ix + v * r * ox).toFixed(3)} ${(cy - u * r * iy + v * r * oy).toFixed(3)}`;
    parts.push(`${parts.length === 0 ? 'M' : 'L'} ${pt([a, 0])}`);
    for (const seg of segments) parts.push(`C ${seg.map(pt).join(' ')}`);
  }
  return `${parts.join(' ')} Z`;
}

async function applyMask(pngBuf, size) {
  const d = continuousSquarePath(size, size * ICON_CORNER_RATIO);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><path d="${d}" fill="#fff"/></svg>`;
  const maskPng = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(pngBuf).ensureAlpha().composite([{ input: maskPng, blend: 'dest-in' }]).png().toBuffer();
}

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

async function rasterizeTile(svgPath, bgColor, size) {
  const meta = await sharp(svgPath).metadata();
  return sharp(svgPath, { density: 72 * (size / meta.width) })
    .flatten({ background: bgColor })
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

async function composeIconCanvas(svgPath, bgColor) {
  const C = 2048;
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
  if (process.platform !== 'darwin') {
    throw new Error('icon.icns can only be regenerated on macOS (iconutil) — re-run `pnpm build:icons` on a Mac before committing.');
  }
  const src = path.join(KIT, 'White Background.svg');
  const canvas = await composeIconCanvas(src, '#ffffff');
  const resize = (s) => sharp(canvas).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer();

  save(path.join(BUILD, 'icon.png'), await resize(512));

  const darkCanvas = await composeIconCanvas(path.join(KIT, 'Black Background.svg'), '#000000');
  save(
    path.join(BUILD, 'icon-dark.png'),
    await sharp(darkCanvas).resize(512, 512, { kernel: 'lanczos3' }).png().toBuffer(),
  );

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const full = await applyMask(await rasterizeTile(src, '#ffffff', 2712), 2712);
  const resizeFull = (s) => sharp(full).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer();
  const ico = icoBuffer(await Promise.all(icoSizes.map(resizeFull)), icoSizes);
  save(path.join(BUILD, 'icon.ico'), ico);
  save(path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'public', 'favicon.ico'), ico);

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

const CANARY_RECOLORS = [
  ['#117DFB', '#F0A500'],
  ['#449BFF', '#FFC61A'],
  ['#77B6FF', '#FFD964'],
  ['#2389FF', '#FFC61A'],
  ['#1783FF', '#F0A500'],
  ['#007CFF', '#FFC61A'],
];

const PREVIEW_RECOLORS = [
  ['#117DFB', '#159A55'],
  ['#449BFF', '#36B96E'],
  ['#77B6FF', '#72D599'],
  ['#2389FF', '#36B96E'],
  ['#1783FF', '#159A55'],
  ['#007CFF', '#36B96E'],
];

function channelRecolor(svg, srcName, channel, recolors) {
  let out = svg;
  for (const [from, to] of recolors) {
    if (!out.includes(from)) throw new Error(`${srcName}: ${channel} recolor source ${from} not found`);
    out = out.split(from).join(to);
  }
  return out;
}

async function buildChannelIcons(channel, recolors) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `brand-${channel}-`));
  const recolor = (srcName) => {
    const srcPath = path.join(KIT, srcName);
    const out = path.join(tmpDir, `${channel}-${srcName}`);
    fs.writeFileSync(out, channelRecolor(fs.readFileSync(srcPath, 'utf8'), srcName, channel, recolors));
    return out;
  };
  const lightSource = recolor('White Background.svg');
  const lightCanvas = await composeIconCanvas(lightSource, '#ffffff');
  const darkCanvas = await composeIconCanvas(recolor('Black Background.svg'), '#000000');
  const resize = (canvas) => (s) => sharp(canvas).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer();

  save(path.join(BUILD, `icon-${channel}.png`), await resize(lightCanvas)(512));
  save(path.join(BUILD, `icon-${channel}-dark.png`), await resize(darkCanvas)(512));
  if (channel === 'preview' || channel === 'canary') {
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const full = await applyMask(await rasterizeTile(lightSource, '#ffffff', 2712), 2712);
    save(path.join(BUILD, `icon-${channel}.ico`), icoBuffer(await Promise.all(sizes.map(resize(full))), sizes));
  }

  const iconset = path.join(tmpDir, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const resizeLight = resize(lightCanvas);
  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(`${iconset}/icon_${base}x${base}.png`, await resizeLight(base));
    fs.writeFileSync(`${iconset}/icon_${base}x${base}@2x.png`, await resizeLight(base * 2));
  }
  const icnsOut = path.join(BUILD, `icon-${channel}.icns`);
  const res = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icnsOut], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`iconutil (${channel}) failed`);
  written.push(path.relative(ROOT, icnsOut));
}

async function buildTrayIcons() {
  const aw = await sharp(path.join(KIT, 'All White.png')).png().toBuffer();
  const { width: awW, height: awH } = await sharp(aw).metadata();
  for (const [canvas, box] of [[22, 16], [44, 32]]) {
    const png = await fitOnCanvas(aw, awW, awH, canvas, box);
    const suffix = canvas === 22 ? '' : '@2x';
    save(path.join(BUILD, `trayTemplate${suffix}.png`), png);
    save(path.join(BUILD, `tray${suffix}.png`), png);
  }

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

const fmt = (x) => {
  const s = x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

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

function markInner(kit, s, { gradIdAttr, gradFillAttr, chevronStroke, indent, canary = false }) {
  const sp = kit.paths.map((p) => scalePath(p.d, s));
  const [gx, gy, gr] = [1, 2, 3].map((i) => fmt(parseFloat(kit.grad[i]) * s));
  const t = {
    x: fmt(parseFloat(kit.term.x ?? '0') * s),
    y: fmt(parseFloat(kit.term.y ?? '0') * s),
    w: fmt(parseFloat(kit.term.width) * s),
    h: fmt(parseFloat(kit.term.height) * s),
    rx: fmt(parseFloat(kit.term.rx) * s),
  };
  for (const i of [4, 5]) {
    if (!kit.paths[i]['stroke-width']) throw new Error(`kit path ${i}: stroke-width not found`);
  }
  const swChevron = fmt(parseFloat(kit.paths[4]['stroke-width']) * s);
  const swDash = fmt(parseFloat(kit.paths[5]['stroke-width']) * s);
  const canaryColors = Object.fromEntries(CANARY_RECOLORS);
  const paint = (attribute, stable) =>
    canary ? `:${attribute}="canary ? '${canaryColors[stable]}' : '${stable}'"` : `${attribute}="${stable}"`;
  const i1 = indent;
  const i2 = indent + '  ';
  const i3 = indent + '    ';
  return [
    `${i1}<defs>`,
    `${i2}<radialGradient ${gradIdAttr} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${gx} ${gy}) scale(${gr})">`,
    `${i3}<stop ${paint('stop-color', '#117DFB')} />`,
    `${i3}<stop offset="0.759254" ${paint('stop-color', '#449BFF')} />`,
    `${i3}<stop offset="1" ${paint('stop-color', '#77B6FF')} />`,
    `${i2}</radialGradient>`,
    `${i1}</defs>`,
    `${i1}<path d="${sp[0]}" ${paint('fill', '#2389FF')} />`,
    `${i1}<path d="${sp[1]}" ${gradFillAttr} />`,
    `${i1}<g class="ch-eyes" fill="#fff">`,
    `${i2}<path class="ch-eye" d="${sp[2]}" />`,
    `${i2}<path class="ch-eye" d="${sp[3]}" />`,
    `${i1}</g>`,
    `${i1}<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${t.rx}" fill="#002E58" />`,
    `${i1}<path d="${sp[4]}" stroke="${chevronStroke}" stroke-width="${swChevron}" stroke-linecap="round" />`,
    `${i1}<path d="${sp[5]}" ${paint('stroke', '#007CFF')} stroke-width="${swDash}" stroke-linecap="round" />`,
    `${i1}<path d="${sp[6]}" ${paint('fill', '#1783FF')} />`,
  ];
}

function genBrandLogo(kit) {
  const W = 120;
  const s = W / kit.vbW;
  const rx = fmt(0.225 * W);
  const inner = markInner(kit, s, {
    gradIdAttr: ':id="faceId"',
    gradFillAttr: ':fill="`url(#${faceId})`"',
    chevronStroke: 'white',
    indent: '    ',
    canary: true,
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
    `            <svg ref="logoRef" class="ch-logo" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick">`,
    ...inner,
    '            </svg>',
  ].join('\n');
}

function spliceBrandMark(file, block, srcName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^([ \t]*)<!-- brand-mark:start/m);
  if (!m) throw new Error(`${path.relative(ROOT, file)}: brand-mark:start marker not found`);
  const indent = m[1];
  const start =
    `${indent}<!-- brand-mark:start — generated by scripts/icon-tools/build-brand-icons.mjs from\n` +
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
  const app = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer');
  spliceBrandMark(path.join(app, 'components/onboarding/BrandLogo.vue'), brandLogo, 'White Background.svg');
  spliceBrandMark(path.join(app, 'components/Sidebar.vue'), sidebarLogo, 'Original Logo.svg');
}

const channelsOnly = process.argv.includes('--channels-only');
if (!channelsOnly) await buildAppIcons();
await buildChannelIcons('canary', CANARY_RECOLORS);
await buildChannelIcons('preview', PREVIEW_RECOLORS);
if (!channelsOnly) {
  await buildTrayIcons();
  buildComponentMarks();
}
console.log('Regenerated brand resources:');
for (const f of written) console.log('  ✓', f);
