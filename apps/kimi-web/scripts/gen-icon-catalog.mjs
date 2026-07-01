// scripts/gen-icon-catalog.mjs — generate the design-system §02 icon catalog
// HTML from the canonical registry (lib/icons.ts) so the two can never drift.
// Run: node --experimental-strip-types scripts/gen-icon-catalog.mjs
import { ICONS } from '../src/lib/icons.ts';

// Display order + grouping. Names not listed here are appended under "Other".
const GROUPS = [
  ['Actions', ['plus', 'close', 'check', 'search', 'copy', 'link', 'external-link', 'download', 'undo', 'send', 'image', 'settings', 'sliders', 'log-in']],
  ['Navigation & layout', ['chevron-down', 'chevron-right', 'arrow-up', 'arrow-down', 'arrow-right', 'minus', 'panel-collapse', 'panel-expand', 'expand', 'collapse', 'list']],
  ['Files & tools', ['folder', 'folder-closed', 'folder-plus', 'folder-solid', 'file', 'file-text', 'file-plus', 'file-off', 'image-off', 'code', 'terminal', 'pencil', 'glob', 'globe', 'check-list', 'bolt', 'git-pull-request']],
  ['Communication', ['message', 'mail', 'user']],
  ['Status & media', ['info', 'help-circle', 'alert-triangle', 'clock', 'sparkles', 'play', 'stop', 'star', 'star-outline', 'dots-vertical', 'dots-horizontal']],
];

function render(name) {
  const def = ICONS[name];
  const vb = def.viewBox ?? '0 0 16 16';
  const fillAttrs = def.fill
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="p-ic" viewBox="${vb}" ${fillAttrs}>${def.body}</svg>`;
}

const seen = new Set();
const lines = [];
lines.push('<div class="icon-grid">');
for (const [label, names] of GROUPS) {
  lines.push(`  <div class="icon-group-label">${label.replaceAll('&', '&amp;')}</div>`);
  for (const name of names) {
    seen.add(name);
    lines.push(`  <div class="icon-cell">${render(name)}<span class="ic-name">${name}</span></div>`);
  }
}
const rest = Object.keys(ICONS).filter((n) => !seen.has(n));
if (rest.length) {
  lines.push('  <div class="icon-group-label">Other</div>');
  for (const name of rest) {
    lines.push(`  <div class="icon-cell">${render(name)}<span class="ic-name">${name}</span></div>`);
  }
}
lines.push('</div>');

process.stdout.write(lines.join('\n') + '\n');
