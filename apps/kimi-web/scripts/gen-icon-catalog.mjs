// scripts/gen-icon-catalog.mjs — generate the design-system §02 icon catalog
// HTML from the canonical registry (lib/icons.ts) so the two can never drift.
// Run: node --experimental-strip-types scripts/gen-icon-catalog.mjs
import { ICON_DATA } from '../src/lib/icon-data.ts';

// Display order + grouping. Names not listed here are appended under "Other".
const GROUPS = [
  ['Actions', ['plus', 'chat-new', 'close', 'check', 'search', 'copy', 'link', 'external-link', 'download', 'undo', 'send', 'image', 'settings', 'sliders', 'log-in']],
  ['Navigation & layout', ['chevron-down', 'chevron-right', 'arrow-up', 'arrow-down', 'arrow-right', 'minus', 'panel-collapse', 'panel-expand', 'expand', 'collapse', 'list']],
  ['Files & tools', ['folder', 'folder-closed', 'folder-plus', 'folder-solid', 'file', 'file-text', 'file-plus', 'file-off', 'image-off', 'code', 'terminal', 'pencil', 'glob', 'globe', 'check-list', 'bolt', 'git-pull-request']],
  ['Communication', ['message', 'mail', 'user']],
  ['Status & media', ['info', 'help-circle', 'alert-triangle', 'clock', 'sparkles', 'play', 'stop', 'star', 'star-outline', 'dots-horizontal']],
];

function render(name) {
  const d = ICON_DATA[name];
  const vb = `0 0 ${d.width ?? 24} ${d.height ?? 24}`;
  return `<svg class="p-ic" viewBox="${vb}" fill="currentColor">${d.body}</svg>`;
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
const rest = Object.keys(ICON_DATA).filter((n) => !seen.has(n));
if (rest.length) {
  lines.push('  <div class="icon-group-label">Other</div>');
  for (const name of rest) {
    lines.push(`  <div class="icon-cell">${render(name)}<span class="ic-name">${name}</span></div>`);
  }
}
lines.push('</div>');

process.stdout.write(lines.join('\n') + '\n');
