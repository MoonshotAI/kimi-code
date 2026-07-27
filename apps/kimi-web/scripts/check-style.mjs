#!/usr/bin/env node
// check-style.mjs — design-system §06 anti-pattern guard for apps/kimi-web.
//
// Scans src/** for the rules in the design system (§06 of the DesignSystemView spec):
//   no-gradient-text, no-glassmorphism (.frost exempt), no-color-glow,
//   icon-from-registry (hand-written <svg>; Icon/Spinner/MoonSpinner + the
//   32x22 brand mark exempt), no-emoji-icon (moon in MoonSpinner exempt),
//   no-hardcoded-hex (DiffView/DiffLines/Terminal domain colors + var()
//   fallbacks exempt), no-hardcoded-font (token definitions exempt),
//   radius-from-scale, z-from-scale, weight-from-scale.
//
// Default mode: report a baseline and exit 0 (warnings only). Pass --strict
// to exit 1 when any finding exists (flipped on in P3 enforcement).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const STRICT = process.argv.includes('--strict');

const DOMAIN_HEX_EXEMPT = new Set([
  'chat/DiffView.vue',
  'chat/DiffLines.vue',
  'Terminal.vue',
]);

// Files that legitimately render their own <svg>: bespoke data-viz / colored
// illustrations, the spinner, and brand marks (the Kimi wordmark on the loading
// screen). Everything else should use lib/icons.ts via <Icon>/iconSvg(). The
// 32x22 Kimi eye logo is also exempted inline (matched by viewBox). The icon
// primitive (components/ui/Icon.vue) itself renders no hand-written <svg>, so it
// is not exempted here.
const ICON_EXEMPT = new Set([
  'components/ui/Spinner.vue',
  'components/ui/MoonSpinner.vue',
  'components/ui/ContextRing.vue',
  'components/ui/AuthStateIcon.vue',
  'components/GlobalLoading.vue',
]);

// Files entirely exempt from the §06 scan. The design-system showcase view is
// documentation/demo CSS (forced-dark previews, syntax-highlighting palettes,
// illustrative mockups) rather than product UI, so the anti-pattern rules do not
// apply to it.
const FILE_EXEMPT = new Set(['views/DesignSystemView.vue']);

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

  for (const { text, baseLine } of blocks) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = baseLine + i;
      const trimmed = raw.trim();
      const isTokenDef = /^\s*--[\w-]+\s*:/.test(raw);

      // no-gradient-text (a custom-property definition is never rendered text
      // itself, so gradient tokens like --media-alpha-canvas don't count)
      if (!isTokenDef && /\b(?:linear|radial|conic)-gradient\s*\(/i.test(raw)) {
        add('no-gradient-text', file, line, trimmed.slice(0, 80));
      }

      // no-glassmorphism (TopBar frost variant exempt)
      if (/backdrop-filter\s*:/i.test(raw) && !/\bfrost\b/.test(text)) {
        add('no-glassmorphism', file, line, trimmed.slice(0, 80));
      }

      // no-hardcoded-font (skip token definitions)
      if (/font-family\s*:/i.test(raw) && !isTokenDef) {
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
      if (wMatch) {
        const v = wMatch[1].trim();
        if (!(v.startsWith('var(') || WEIGHT_OK.has(v))) {
          add('weight-from-scale', file, line, `${v} · ${trimmed.slice(0, 60)}`);
        }
      }
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
  // come from lib/icons.ts via <Icon>/iconSvg(). Exempt the brand mark (32x22
  // logo) and the primitive components listed in ICON_EXEMPT. Skips <svg> that
  // falls inside <style>/<script> blocks.
  if (!isCss && !ICON_EXEMPT.has(file)) {
    const blockRanges = [...content.matchAll(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi)]
      .map((m) => [m.index, m.index + m[0].length]);
    const inBlock = (idx) => blockRanges.some(([a, b]) => idx >= a && idx < b);
    const svgRe = /<svg\b[^>]*>/gi;
    let m;
    while ((m = svgRe.exec(content)) !== null) {
      if (inBlock(m.index)) continue;
      if (/viewBox="0 0 32 22"/.test(m[0])) continue; // Kimi brand mark
      add('icon-from-registry(warn)', file, lineOf(content, m.index), m[0].slice(0, 80));
    }
  }
}

const files = walk(SRC);
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
