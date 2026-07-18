import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.vite']);

// Words that are clearly HTML elements, CSS, or programming keywords — not i18n targets
const SKIP_WORDS = new Set([
  'div', 'span', 'button', 'template', 'svg', 'g', 'path', 'rect', 'mask',
  'defs', 'title', 'thead', 'tbody', 'tr', 'th', 'td', 'table', 'label',
  'input', 'form', 'section', 'header', 'footer', 'nav', 'main', 'aside',
  'article', 'figure', 'figcaption', 'select', 'option', 'textarea',
  'pre', 'code', 'blockquote', 'hr', 'br', 'img', 'slot', 'slot',
  'Transition', 'transition', 'TransitionGroup', 'KeepAlive',
  'Teleport', 'Suspense', 'RouterView', 'RouterLink',
  'Component', 'component', 'text', 'color', 'width', 'height', 'size',
  'left', 'right', 'top', 'bottom', 'center', 'middle', 'small', 'large',
  'yes', 'no', 'ok', 'on', 'off', 'true', 'false', 'null', 'undefined',
  'Kimi', 'Code', 'API', 'URL', 'ID', 'UI', 'UX', 'AI',
]);

// Known i18n patterns that mean the file is already internationalized
const I18N_PATTERNS = [
  /\$t\(/, /t\(/, /useI18n/, /i18n\.global/, /import.*i18n/, /from.*i18n/,
  /\bt\(['"`]/, /\$t\(['"`]/,
];

function hasI18n(content) {
  return I18N_PATTERNS.some(p => p.test(content));
}

// Collect all unique hardcoded strings found
const findings = [];

function scanFile(filePath, content) {
  const lines = content.split('\n');
  const relPath = relative(ROOT, filePath).replace(/\\/g, '/');
  const alreadyI18n = hasI18n(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments, style blocks, pure HTML tags
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line) || /^\s*<!--/.test(line)) continue;
    if (line.includes('class=') && !/>[A-Z]/.test(line)) continue;

    // Pattern 1: >Text< in template — hardcoded visible text
    const textMatch = line.match(/>([A-Z][a-z]+(?:\s+[a-z]+)*)\s*<\//);
    if (textMatch) {
      const word = textMatch[1].trim();
      if (word.length > 2 && !SKIP_WORDS.has(word) && !alreadyI18n) {
        findings.push({ file: relPath, line: lineNum, text: word, context: line.trim() });
      }
    }

    // Pattern 2: "Text" as attribute value that looks like a label
    const attrMatch = line.match(/"(?:label|title|placeholder|aria-label|text|message)"\s*:\s*"([A-Z][^"]{3,})"/);
    if (attrMatch && !line.includes('$t(') && !line.includes('t(')) {
      const text = attrMatch[1];
      if (text.length > 2 && !SKIP_WORDS.has(text)) {
        findings.push({ file: relPath, line: lineNum, text: `attr: ${text}`, context: line.trim() });
      }
    }
  }
}

function walkDir(dir) {
  try {
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const full = join(dir, file.name);
      if (file.isDirectory()) {
        if (!SKIP_DIRS.has(file.name)) walkDir(full);
      } else if (/\.(vue|tsx|ts)$/.test(file.name)) {
        // Only scan UI source files
        if (full.includes('components') || full.includes('views') || full.includes('pages') || full.includes('tui') || full.includes('cli')) {
          try {
            const content = readFileSync(full, 'utf-8');
            scanFile(full, content);
          } catch { /* skip binary */ }
        }
      }
    }
  } catch { /* skip unreadable */ }
}

// Scan the main source directories
const SCAN_DIRS = [
  'apps/kimi-web/src/components',
  'apps/kimi-web/src/views',
  'apps/kimi-code/src/tui',
  'apps/kimi-code/src/migration',
  'apps/kimi-inspect/src',
  'apps/vis/web/src',
  'apps/vscode/webview-ui/src',
];

for (const d of SCAN_DIRS) {
  const full = join(ROOT, d);
  try {
    if (statSync(full).isDirectory()) walkDir(full);
  } catch { /* skip */ }
}

// Report findings grouped by directory
const byDir = {};
for (const f of findings) {
  const dir = f.file.split('/')[0] + '/' + f.file.split('/')[1];
  (byDir[dir] = byDir[dir] || []).push(f);
}

for (const [dir, items] of Object.entries(byDir)) {
  console.log(`\n=== ${dir} (${items.length} findings) ===`);
  for (const item of items.slice(0, 20)) {
    console.log(`  ${item.file}:${item.line} → "${item.text}"`);
  }
  if (items.length > 20) console.log(`  ... and ${items.length - 20} more`);
}

console.log(`\nTotal: ${findings.length} hardcoded strings found across ${Object.keys(byDir).length} directories`);