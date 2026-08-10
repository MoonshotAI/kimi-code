/**
 * CI check: verify every `t('namespace.key')` call in source code has a
 * corresponding entry in the main i18n locale files.
 *
 * Usage: node scripts/check-t-call-coverage.mjs
 * Exit code: 0 if all keys are covered, 1 if any key is missing.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────────────

const LOCALE_FILE = 'packages/i18n/src/locales/en.ts';
const SOURCE_DIRS = [
];

// ── Simple recursive file walker ─────────────────────────────────────────────

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === '.ts' && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        yield fullPath;
      }
    }
  }
}

// ── Load locale keys ────────────────────────────────────────────────────────

function collectLeafKeys(obj, prefix = '') {
  const keys = new Set();
  if (obj === null || typeof obj !== 'object') return keys;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      const children = collectLeafKeys(value, fullKey);
      for (const c of children) keys.add(c);
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

let localeKeys;
async function loadLocaleKeys() {
  if (localeKeys) return localeKeys;
  const fullPath = resolve(ROOT, LOCALE_FILE);
  try {
    const mod = await import(pathToFileURL(fullPath).href);
    const data = mod.default || mod;
    localeKeys = collectLeafKeys(data);
    return localeKeys;
  } catch (err) {
    console.error(`Cannot load locale file ${LOCALE_FILE}: ${err.message}`);
    process.exit(1);
  }
}

// ── Scan source for t() calls ────────────────────────────────────────────────

const T_CALL_RE = /(?<![a-zA-Z0-9_$.])t\(['"]([a-zA-Z0-9_.]+)['"]/g;

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const calls = [];
  let match;
  while ((match = T_CALL_RE.exec(content)) !== null) {
    calls.push(match[1]);
  }
  return calls;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const localeKeySet = await loadLocaleKeys();
  const allCalls = new Map(); // key -> [file1, file2, ...]
  const files = [];

  for (const dir of SOURCE_DIRS) {
    const fullDir = resolve(ROOT, dir);
    for (const filePath of walkFiles(fullDir)) {
      const relPath = relative(ROOT, filePath);
      files.push(relPath);
      const calls = scanFile(filePath);
      for (const key of calls) {
        if (!allCalls.has(key)) allCalls.set(key, []);
        allCalls.get(key).push(relPath);
      }
    }
  }

  let hasErrors = false;
  const missing = [];

  for (const [key, callFiles] of allCalls) {
    if (!localeKeySet.has(key)) {
      missing.push({ key, files: callFiles });
    }
  }

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n✗ Found ${missing.length} t() call(s) without matching locale key:\n`);
    for (const { key, files } of missing) {
      const uniqueFiles = [...new Set(files)];
      console.error(`  - ${key}`);
      for (const f of uniqueFiles.slice(0, 5)) {
        console.error(`      ${f}`);
      }
      if (uniqueFiles.length > 5) {
        console.error(`      ... and ${uniqueFiles.length - 5} more files`);
      }
    }
  }

  console.log(`\nChecked ${files.length} files, ${allCalls.size} unique t() keys.`);
  if (hasErrors) {
    console.error('\n❌ Some t() calls have no matching locale key — add them to packages/i18n/src/locales/{en,zh}.ts\n');
    process.exit(1);
  } else {
    console.log('\n✅ All t() calls have matching locale keys.\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});