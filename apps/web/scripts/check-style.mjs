#!/usr/bin/env node
// check-style.mjs — design-system §06 anti-pattern guard for apps/kimi-web.
//
// Scans src/** for the rules in the design system (§06 of the DesignSystemView spec):
//   no-gradient-text, no-glassmorphism (.frost + whitelisted menu files using
//   exactly var(--p-menu-backdrop) exempt), no-color-glow,
//   icon-from-registry (hand-written <svg>; Icon/Spinner + the
//   32x22 / 32x28.x / 120x120 brand marks exempt), no-emoji-icon,
//   no-hardcoded-hex (DiffView/Terminal domain colors + var()
//   fallbacks exempt), no-hardcoded-font (token and @font-face definitions exempt),
//   radius-from-scale, z-from-scale, weight-from-scale.
//
// Default mode: report a baseline and exit 0 (warnings only). Pass --strict
// to exit 1 when any finding exists (flipped on in P3 enforcement).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const SRC = path.join(ROOT, 'src');
// §06 guard also covers the design-system primitives that moved into web-ui.
// Apps/web keys keep a '' label so the exemption sets below stay keyed to
// apps/web-relative paths; web-ui files are reported under a 'web-ui/' prefix.
const SCAN_ROOTS = [
  { dir: SRC, label: '' },
  { dir: path.join(REPO_ROOT, 'packages', 'web-ui', 'src'), label: 'web-ui/' },
];
const STRICT = process.argv.includes('--strict');

const DOMAIN_HEX_EXEMPT = new Set([
  'chat/DiffView.vue',
  'Terminal.vue',
]);

// Files that legitimately render their own <svg>: bespoke data-viz / colored
// illustrations, the spinner, and brand marks (the Kimi wordmark on the loading
// screen). Everything else should use lib/icons.ts via <Icon>/iconSvg(). The
// 32x22 Kimi eye logo (auth page) and the 32x28.x robot mascot (sidebar
// header, height tracks the brand kit's aspect ratio) are also exempted
// inline (matched by viewBox). The icon
// primitive (components/ui/Icon.vue) itself renders no hand-written <svg>, so it
// is not exempted here.
const ICON_EXEMPT = new Set([
  'components/GlobalLoading.vue',
  'components/KimiMascot.vue', // static brand-blob fallback for the Rive canvas
]);

// Files entirely exempt from the §06 scan. The design-system showcase view is
// documentation/demo CSS (forced-dark previews, syntax-highlighting palettes,
// illustrative mockups) rather than product UI, so the anti-pattern rules do not
// apply to it.
const FILE_EXEMPT = new Set(['views/DesignSystemView.vue']);

// The §03 floating menu surfaces allowed to use the frosted-glass token pair
// (--color-menu-bg + --p-menu-backdrop). Any other file using backdrop-filter
// (and any ad-hoc blur value, even in these files) is flagged. ChatDock is
// deliberately absent: its work panel stays open over the scrolling
// transcript, where a live backdrop blur re-samples every frame and janks.
const GLASS_MENU_EXEMPT = new Set([
  'web-ui/components/ui/Menu.vue',
  'web-ui/components/ui/Select.vue',
  'components/chat/Composer.vue',
  'components/chat/SlashMenu.vue',
  'components/chat/MentionMenu.vue',
  'components/chat/ConversationPane.vue',
]);

// Files exempt from no-gradient-text. The rule targets gradient TEXT, but the
// line regex matches any gradient — these use background opacity ramps as
// edge-fade veils over scrolling content, an accepted design primitive (the
// Sidebar column fades in the baseline and the ApprovalCard plan-scroll seam
// are the same pattern).
const GRADIENT_EXEMPT = new Set(['components/chat/ChatDock.vue', 'components/chat/ApprovalCard.vue']);

const RADIUS_SCALE = new Set([4, 6, 8, 12, 16, 20, 999]);
const WEIGHT_OK = new Set([
  '400', '500',
  'normal', 'bolder', 'lighter',
  'inherit', 'initial', 'unset', 'revert',
]);
const Z_OK = new Set(['0', '1', '-1', 'auto']);

/** @type {{ rule: string, file: string, line: number, detail: string }[]} */
const findings = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(vue|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(abs) {
  for (const { dir, label } of SCAN_ROOTS) {
    const r = path.relative(dir, abs);
    if (!r.startsWith('..') && !path.isAbsolute(r)) return label + r.replaceAll(path.sep, '/');
  }
  return path.relative(SRC, abs).replaceAll(path.sep, '/');
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function add(rule, file, line, detail) {
  findings.push({ rule, file, line, detail });
}

function stripVarSpans(line) {
  // Remove var(...) substrings so var() fallbacks don't trip hex checks.
  return line.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
}

function extractStyleBlocks(content) {
  // For .vue: return [{text, baseLine}] for each <style> block.
  // For .css: single block = whole file.
  const blocks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    blocks.push({ text: m[1], baseLine: lineOf(content, m.index) });
  }
  return blocks;
}

function checkFile(abs) {
  const content = fs.readFileSync(abs, 'utf8');
  const file = rel(abs);
  if (FILE_EXEMPT.has(file)) return;
  const isCss = abs.endsWith('.css');
  const blocks = isCss ? [{ text: content, baseLine: 1 }] : extractStyleBlocks(content);
  const domainExempt = DOMAIN_HEX_EXEMPT.has(file);
  const gradientExempt = GRADIENT_EXEMPT.has(file);

  for (const { text, baseLine } of blocks) {
    const lines = text.split('\n');
    let inFontFace = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = baseLine + i;
      const trimmed = raw.trim();
      const isTokenDef = /^\s*--[\w-]+\s*:/.test(raw);
      if (/^@font-face\b/i.test(trimmed)) inFontFace = true;

      // no-gradient-text (a custom-property definition is never rendered text
      // itself, so gradient tokens like --media-alpha-canvas don't count;
      // mask-image gradients are alpha masks, not rendered colour)
      if (!gradientExempt && !isTokenDef && !/mask-image\s*:/i.test(raw) && /\b(?:linear|radial|conic)-gradient\s*\(/i.test(raw)) {
        add('no-gradient-text', file, line, trimmed.slice(0, 80));
      }

      // no-glassmorphism (TopBar frost variant exempt; whitelisted menu
      // surfaces may use exactly var(--p-menu-backdrop) — any other file or any
      // ad-hoc value, including a token-name mention in a comment, is flagged.
      // Every declaration on the line must pass: a whitelisted first match must
      // not smuggle an ad-hoc second one through.)
      const backdropDecls = [...raw.matchAll(/\bbackdrop-filter\s*:\s*([^;]+)/gi)];
      if (backdropDecls.length > 0) {
        const menuGlass =
          GLASS_MENU_EXEMPT.has(file) &&
          backdropDecls.every((m) => m[1].trim() === 'var(--p-menu-backdrop)');
        if (!menuGlass && !/\bfrost\b/.test(text)) {
          add('no-glassmorphism', file, line, trimmed.slice(0, 80));
        }
      }

      // no-hardcoded-font (skip token definitions and the family declaration
      // that gives a bundled font asset its CSS name)
      if (/font-family\s*:/i.test(raw) && !isTokenDef && !inFontFace) {
        const val = raw.split(':').slice(1).join(':');
        if (!/var\(/.test(val) && /["']/.test(val)) {
          add('no-hardcoded-font', file, line, trimmed.slice(0, 80));
        }
      }

      // no-hardcoded-hex (token sheet *.css + domain files + var() fallbacks exempt)
      if (!domainExempt && !isCss) {
        const scannable = stripVarSpans(raw);
        const hexRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
        let h;
        while ((h = hexRe.exec(scannable)) !== null) {
          add('no-hardcoded-hex', file, line, `${h[0]} · ${trimmed.slice(0, 70)}`);
        }
      }

      // radius-from-scale (report once per declaration)
      const rMatch = raw.match(/border-radius\s*:\s*([^;}]+)/i);
      if (rMatch) {
        const tokens = rMatch[1].trim().split(/\s+/);
        const bad = [];
        for (const t of tokens) {
          if (t.startsWith('var(') || t === '0' || t === '0px' || t.endsWith('%')) continue;
          const px = t.match(/^(\d+(?:\.\d+)?)px$/);
          if (px && RADIUS_SCALE.has(Number(px[1]))) continue;
          if (!bad.includes(t)) bad.push(t);
        }
        if (bad.length) add('radius-from-scale', file, line, `${bad.join(' ')} · ${trimmed.slice(0, 50)}`);
      }

      // z-from-scale
      const zMatch = raw.match(/z-index\s*:\s*([^;}]+)/i);
      if (zMatch) {
        const v = zMatch[1].trim();
        if (!(v.startsWith('var(') || Z_OK.has(v))) {
          add('z-from-scale', file, line, `${v} · ${trimmed.slice(0, 60)}`);
        }
      }

      // weight-from-scale
      const wMatch = raw.match(/font-weight\s*:\s*([^;}]+)/i);
      if (wMatch && !inFontFace) {
        const v = wMatch[1].trim();
        if (!(v.startsWith('var(') || WEIGHT_OK.has(v))) {
          add('weight-from-scale', file, line, `${v} · ${trimmed.slice(0, 60)}`);
        }
      }

      if (inFontFace && trimmed === '}') inFontFace = false;
    }

    // no-color-glow (block-level heuristic: colored shadow with large blur) — warning only
    const shadowRe = /box-shadow\s*:[^;}]*?(?:rgba?\([^)]*?\)|hsla?\([^)]*?\)|#[0-9a-fA-F]{3,8})[^;}]*?(?:\d{2,})px/gi;
    let s;
    while ((s = shadowRe.exec(text)) !== null) {
      const glowLine = baseLine + lineOf(text, s.index) - 1;
      add('no-color-glow(warn)', file, glowLine, s[0].slice(0, 80));
    }
  }

  // icon-from-registry (warning only): hand-written <svg> in templates should
  // come from lib/icons.ts via <Icon>/iconSvg(). Exempt the brand marks (auth
  // eye logo, sidebar robot mascot) and the primitive components listed in
  // ICON_EXEMPT. Skips <svg> that falls inside <style>/<script> blocks.
  if (!isCss && !ICON_EXEMPT.has(file)) {
    const blockRanges = [...content.matchAll(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi)]
      .map((m) => [m.index, m.index + m[0].length]);
    const inBlock = (idx) => blockRanges.some(([a, b]) => idx >= a && idx < b);
    const svgRe = /<svg\b[^>]*>/gi;
    let m;
    while ((m = svgRe.exec(content)) !== null) {
      if (inBlock(m.index)) continue;
      if (/viewBox="0 0 (32 (22|28\.\d+)|120 120)"/.test(m[0])) continue; // Kimi brand marks (auth eye logo 32x22, sidebar robot mascot 32x28.x — height follows the kit's aspect, onboarding app-icon tile 120x120)
      add('icon-from-registry(warn)', file, lineOf(content, m.index), m[0].slice(0, 80));
    }
  }
}

const files = [];
for (const { dir } of SCAN_ROOTS) walk(dir, files);
for (const f of files) checkFile(f);

// Report
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}

const order = [
  'no-gradient-text', 'no-glassmorphism', 'no-color-glow(warn)',
  'icon-from-registry(warn)',
  'no-hardcoded-hex', 'no-hardcoded-font', 'radius-from-scale',
  'z-from-scale', 'weight-from-scale',
];

let total = 0;
for (const rule of order) {
  const list = byRule.get(rule) || [];
  if (list.length === 0) continue;
  total += list.length;
  console.log(`\n${rule} — ${list.length}`);
  for (const f of list.slice(0, 12)) {
    console.log(`  ${f.file}:${f.line}  ${f.detail}`);
  }
  if (list.length > 12) console.log(`  … and ${list.length - 12} more`);
}

// Any rules not in the explicit order
for (const [rule, list] of byRule) {
  if (order.includes(rule)) continue;
  total += list.length;
  console.log(`\n${rule} — ${list.length}`);
  for (const f of list.slice(0, 12)) console.log(`  ${f.file}:${f.line}  ${f.detail}`);
}

const warnOnly = [...byRule.keys()].every((r) => r.endsWith('(warn)'));
console.log(`\ncheck-style: ${total} finding(s) across ${byRule.size} rule(s).${STRICT ? '' : ' (baseline mode — not failing)'}`);

if (STRICT && total > 0 && !warnOnly) process.exit(1);
