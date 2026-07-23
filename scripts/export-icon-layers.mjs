#!/usr/bin/env node
// export-icon-layers.mjs — split the KIMI CODE LOGO kit's White/Black
// Background.svg into per-layer SVGs (+ 1024² PNGs) for Apple Icon Composer:
//
//   node scripts/export-icon-layers.mjs
//
// Output: KIMI CODE LOGO/layers/ — stacking order bottom → top:
//   background(-dark).svg  opaque full-bleed tile (white; black = Dark appearance)
//   head.svg               blue robot head (radial gradient)
//   eyes.svg               white eye pair
//   terminal.svg           navy terminal bar + white chevron + blue dash
//   dot.svg                antenna dot (#1783FF)
//
// Every layer is emitted at 1024×1024 — Icon Composer places imports at their
// intrinsic size on its 1024pt canvas, so smaller SVGs land tiny in the
// middle. All layers share one coordinate space and align when stacked.
// Icon Composer: drag in bottom-to-top, group to taste (max 4 groups), and
// never bake a rounded-rect mask into layers — macOS masks the squircle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'KIMI CODE LOGO');
const OUT = path.join(KIT, 'layers');
const SIZE = 1024; // Icon Composer canvas size (pt)

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is required — run `pnpm install` first.');
  process.exit(1);
}

const fmt = (x) => {
  const s = x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

/** Scale an SVG path's absolute M/L/C/H/Z coordinates by `k`. */
function scalePath(d, k) {
  const tokens = d.match(/[MLCHZmlchz]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  const out = [];
  let cmd = null;
  for (const t of tokens) {
    if (/^[MLCHZ]$/i.test(t)) {
      cmd = t.toUpperCase();
      out.push(t);
    } else if (/^[-\d.]/.test(t)) {
      if (cmd === null || cmd === 'Z') throw new Error(`malformed path: ${d.slice(0, 40)}…`);
      out.push(fmt(parseFloat(t) * k));
    } else {
      throw new Error(`unsupported path command in: ${d.slice(0, 40)}…`);
    }
  }
  return out.join(' ');
}

// Same kit parsing as build-brand-icons.mjs (7 mark paths, terminal rect, face gradient).
function parseKitSvg(file) {
  const src = fs.readFileSync(file, 'utf8');
  const vb = src.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error(`${path.basename(file)}: viewBox not found`);
  const paths = [...src.matchAll(/<path\s+([^>]*?)\s*\/?>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
  if (paths.length !== 7) throw new Error(`${path.basename(file)}: expected 7 paths, got ${paths.length}`);
  const rects = [...src.matchAll(/<rect\s+([^>]*?)\s*\/?>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
  const term = rects.find((r) => r.fill === '#002E58');
  if (!term) throw new Error(`${path.basename(file)}: terminal bar rect not found`);
  const grad = src.match(/<radialGradient[\s\S]*?<\/radialGradient>/);
  if (!grad) throw new Error(`${path.basename(file)}: face radialGradient not found`);
  return { paths, term, grad: grad[0], vbW: parseFloat(vb[1]) };
}

const kit = parseKitSvg(path.join(KIT, 'White Background.svg'));
const K = SIZE / kit.vbW;

const attrs = (a, scaleKeys) =>
  Object.entries(a)
    .map(([k, v]) => `${k}="${scaleKeys(k, v)}"`)
    .join(' ');
const p = kit.paths.map((a) =>
  `<path ${attrs(a, (k, v) => (k === 'd' ? scalePath(v, K) : k === 'stroke-width' ? fmt(parseFloat(v) * K) : v))}/>`,
);
const term = `<rect ${attrs(kit.term, (k, v) => (['x', 'y', 'width', 'height', 'rx'].includes(k) ? fmt(parseFloat(v) * K) : v))}/>`;
// Scale the face gradient's userSpace transform along with the geometry.
const grad = kit.grad.replace(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/, (_m, x, y, r) =>
  `translate(${fmt(parseFloat(x) * K)} ${fmt(parseFloat(y) * K)}) scale(${fmt(parseFloat(r) * K)})`,
);

const wrap = (body, defs = '') =>
  `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n${defs ? `<defs>\n${defs}\n</defs>\n` : ''}</svg>\n`;

const layers = [
  { name: 'background', svg: wrap(`<rect width="${SIZE}" height="${SIZE}" fill="white"/>`), bg: '#ffffff' },
  { name: 'background-dark', svg: wrap(`<rect width="${SIZE}" height="${SIZE}" fill="black"/>`), bg: '#000000' },
  { name: 'head', svg: wrap(`${p[0]}\n${p[1]}`, grad) },
  { name: 'eyes', svg: wrap(`<g fill="#fff">\n${p[2]}\n${p[3]}\n</g>`) },
  { name: 'terminal', svg: wrap(`${term}\n${p[4]}\n${p[5]}`) },
  { name: 'dot', svg: wrap(p[6]) },
];

fs.mkdirSync(OUT, { recursive: true });
for (const layer of layers) {
  fs.writeFileSync(path.join(OUT, `${layer.name}.svg`), layer.svg);
  let img = sharp(Buffer.from(layer.svg)).resize(SIZE, SIZE, { kernel: 'lanczos3' });
  if (layer.bg) img = img.flatten({ background: layer.bg });
  await img.png().toFile(path.join(OUT, `${layer.name}.png`));
  console.log('  ✓', path.relative(ROOT, path.join(OUT, `${layer.name}.svg/.png`)));
}
console.log('Done — stack bottom→top: background, head, eyes, terminal, dot');
