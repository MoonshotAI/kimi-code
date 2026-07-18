/**
 * CI check: verify en/zh locale key consistency across all apps.
 *
 * For each locale source, collects all leaf keys from the English and Chinese
 * message trees and reports any keys that exist in one but not the other.
 *
 * Usage: node scripts/check-locale-keys.mjs
 * Exit code: 0 if all keys match, 1 if any mismatch is found.
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ── Locale source definitions ────────────────────────────────────────────────

const LOCALE_SOURCES = [
  {
    name: 'agent-core',
    en: 'packages/agent-core/src/i18n-locales/en.ts',
    zh: 'packages/agent-core/src/i18n-locales/zh.ts',
  },
  {
    name: 'kimi-code',
    en: 'apps/kimi-code/src/i18n/locales/en.ts',
    zh: 'apps/kimi-code/src/i18n/locales/zh.ts',
  },
  {
    name: 'kap-server',
    en: 'packages/kap-server/src/i18n-locales/en.ts',
    zh: 'packages/kap-server/src/i18n-locales/zh.ts',
  },
  {
    name: 'kimi-inspect',
    en: 'apps/kimi-inspect/src/i18n/locales/en.ts',
    zh: 'apps/kimi-inspect/src/i18n/locales/zh.ts',
  },
  {
    name: 'vis-web',
    en: 'apps/vis/web/src/i18n/locales/en.ts',
    zh: 'apps/vis/web/src/i18n/locales/zh.ts',
  },
  {
    name: 'vscode-webview',
    en: 'apps/vscode/webview-ui/src/i18n/locales/en.ts',
    zh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts',
  },
  {
    name: 'kimi-web',
    src: 'apps/kimi-web/src/i18n/locales/index.ts',
    extract: true,
  },
];

// ── Key collection ───────────────────────────────────────────────────────────

function collectLeafKeys(obj, prefix = '') {
  const keys = [];
  if (obj === null || typeof obj !== 'object') return keys;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      keys.push(...collectLeafKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

// ── Dynamic TS loader ────────────────────────────────────────────────────────

let tsxAvailable = false;
try {
  await import('tsx/esm');
  tsxAvailable = true;
} catch {
  // tsx might not be installed in CI; try registering manually
  try {
    register('tsx/esm', pathToFileURL(import.meta.url));
    tsxAvailable = true;
  } catch {
    // Fallback: use require via createRequire for CommonJS TS files
  }
}

async function loadModule(p) {
  const fullPath = resolve(ROOT, p);
  const fileUrl = pathToFileURL(fullPath).href;
  try {
    const mod = await import(fileUrl);
    return mod.default || mod;
  } catch (err) {
    // Try .ts extension explicitly
    try {
      const mod = await import(`${fileUrl}`);
      return mod.default || mod;
    } catch {
      throw new Error(`Cannot load ${p}: ${err.message}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

let hasErrors = false;

for (const source of LOCALE_SOURCES) {
  try {
    let enData, zhData;

    if (source.extract) {
      // kimi-web: single file exports { messages: { en, zh } }
      const mod = await loadModule(source.src);
      const m = mod.default || mod;
      if (m.messages) {
        enData = m.messages.en;
        zhData = m.messages.zh;
      } else if (m.en && m.zh) {
        enData = m.en;
        zhData = m.zh;
      } else {
        throw new Error('Cannot extract en/zh from module');
      }
    } else {
      enData = await loadModule(source.en);
      zhData = await loadModule(source.zh);
    }

    const enKeys = new Set(collectLeafKeys(enData));
    const zhKeys = new Set(collectLeafKeys(zhData));

    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

    if (missingInZh.length === 0 && missingInEn.length === 0) {
      console.log(`✓ ${source.name}: ${enKeys.size} keys match`);
    } else {
      hasErrors = true;
      console.error(`✗ ${source.name}: key mismatch`);
      if (missingInZh.length > 0) {
        console.error(`  Missing in zh (${missingInZh.length}):`);
        for (const k of missingInZh.slice(0, 20)) {
          console.error(`    - ${k}`);
        }
        if (missingInZh.length > 20) {
          console.error(`    ... and ${missingInZh.length - 20} more`);
        }
      }
      if (missingInEn.length > 0) {
        console.error(`  Missing in en (${missingInEn.length}):`);
        for (const k of missingInEn.slice(0, 20)) {
          console.error(`    - ${k}`);
        }
        if (missingInEn.length > 20) {
          console.error(`    ... and ${missingInEn.length - 20} more`);
        }
      }
    }
  } catch (err) {
    hasErrors = true;
    console.error(`✗ ${source.name}: ${err.message}`);
  }
}

console.log('');
if (hasErrors) {
  console.error('❌ Locale key check failed — fix the mismatches above.');
  process.exit(1);
} else {
  console.log('✅ All locale keys are consistent.');
  process.exit(0);
}
