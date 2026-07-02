#!/usr/bin/env node
// scripts/gen-icon-data.mjs — generate src/lib/icon-data.ts, the tree-shaken
// Remix Icon (ri) subset that backs apps/kimi-web's icon registry.
//
// Single source of truth for "which existing icon name maps to which Remix
// icon" is the NAME_TO_REMIX map below. The SVG bytes are pulled straight from
// @iconify-json/ri at generation time, so the registry stays library-sourced
// (no hand-copied SVG) yet fully offline and tree-shaken (only the icons we
// list here end up in the bundle).
//
// Run after changing the map:  pnpm gen:icons

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ri from '@iconify-json/ri/icons.json' with { type: 'json' };
import { getIconData } from '@iconify/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../src/lib/icon-data.ts');

// Existing icon name → Remix icon name (ri:<name>, prefix omitted here).
// Keep keys sorted within their group; the generated IconName union follows
// this order. Every value must exist in @iconify-json/ri (validated below).
const GROUPS = [
  ['Actions', {
    plus: 'add-line',
    'chat-new': 'chat-new-line',
    close: 'close-line',
    check: 'check-line',
    search: 'search-line',
    copy: 'file-copy-line',
    link: 'links-line',
    'external-link': 'external-link-line',
    download: 'download-line',
    undo: 'arrow-go-back-line',
    send: 'send-plane-line',
    image: 'image-line',
    settings: 'settings-3-line',
    sliders: 'equalizer-line',
    'log-in': 'login-box-line',
  }],
  ['Navigation & layout', {
    'chevron-down': 'arrow-down-s-line',
    'chevron-right': 'arrow-right-s-line',
    'arrow-up': 'arrow-up-line',
    'arrow-down': 'arrow-down-line',
    'arrow-right': 'arrow-right-line',
    minus: 'subtract-line',
    'panel-collapse': 'contract-left-line',
    'panel-expand': 'expand-right-line',
    expand: 'expand-diagonal-line',
    collapse: 'collapse-diagonal-line',
    list: 'list-unordered',
    sort: 'sort-desc',
    grip: 'draggable',
  }],
  ['Files & tools', {
    folder: 'folder-open-line',
    'folder-closed': 'folder-line',
    'folder-plus': 'folder-add-line',
    'folder-solid': 'folder-fill',
    file: 'file-line',
    'file-text': 'file-text-line',
    'file-plus': 'file-add-line',
    'file-off': 'file-line',
    'image-off': 'image-line',
    code: 'code-line',
    terminal: 'terminal-box-line',
    pencil: 'pencil-line',
    glob: 'braces-line',
    globe: 'global-line',
    'check-list': 'list-check',
    bolt: 'flashlight-line',
    'git-pull-request': 'git-pull-request-line',
  }],
  ['Communication', {
    message: 'message-line',
    mail: 'mail-line',
    user: 'user-line',
  }],
  ['Status & media', {
    info: 'information-line',
    'help-circle': 'question-line',
    'alert-triangle': 'alert-line',
    clock: 'time-line',
    sparkles: 'sparkling-line',
    play: 'play-fill',
    stop: 'stop-fill',
    star: 'star-fill',
    'star-outline': 'star-line',
    'dots-horizontal': 'more-line',
  }],
];

const NAME_TO_REMIX = Object.assign({}, ...GROUPS.map(([, m]) => m));

// --- resolve + validate ----------------------------------------------------
const missing = [];
const data = {};
for (const [name, riName] of Object.entries(NAME_TO_REMIX)) {
  const icon = getIconData(ri, riName);
  if (!icon) {
    missing.push(`${name} → ri:${riName}`);
    continue;
  }
  data[name] = { body: icon.body, width: icon.width ?? 24, height: icon.height ?? 24 };
}

if (missing.length) {
  console.error('gen-icon-data: the following Remix icons were not found in @iconify-json/ri:');
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

// --- emit ------------------------------------------------------------------
const names = Object.keys(data);
const keyOf = (n) => (/^[a-zA-Z_$][\w$]*$/.test(n) ? n : JSON.stringify(n));

const lines = [];
lines.push('// GENERATED FILE — do not edit by hand.');
lines.push('// Source of truth: scripts/gen-icon-data.mjs (run `pnpm gen:icons`).');
lines.push('// Icons are Remix Icon (ri) — https://remixicon.com/ — Apache-2.0.');
lines.push('');
lines.push('export type IconName =');
for (let i = 0; i < names.length; i++) {
  const suffix = i === names.length - 1 ? ';' : '';
  lines.push(`  | ${JSON.stringify(names[i])}${suffix}`);
}
lines.push('');
lines.push('export interface IconData {');
lines.push('  /** Inner SVG markup (paths/shapes), rendered inside our <svg> wrapper. */');
lines.push('  body: string;');
lines.push('  /** Source grid width in px. Remix icons are 24. */');
lines.push('  width?: number;');
lines.push('  /** Source grid height in px. Remix icons are 24. */');
lines.push('  height?: number;');
lines.push('}');
lines.push('');
lines.push('/** Existing name → fully-qualified Remix icon id. */');
lines.push('export const NAME_TO_REMIX: Record<IconName, string> = {');
for (const name of names) lines.push(`  ${keyOf(name)}: ${JSON.stringify('ri:' + NAME_TO_REMIX[name])},`);
lines.push('};');
lines.push('');
lines.push('/** Per-icon SVG data, pulled from @iconify-json/ri. */');
lines.push('export const ICON_DATA: Record<IconName, IconData> = {');
for (const name of names) {
  const { body, width, height } = data[name];
  lines.push(`  ${keyOf(name)}: { body: ${JSON.stringify(body)}, width: ${width}, height: ${height} },`);
}
lines.push('};');
lines.push('');

writeFileSync(OUT, lines.join('\n'));
console.log(`gen-icon-data: wrote ${names.length} icons to src/lib/icon-data.ts`);
