/**
 * Generate JSON locale files from TypeScript locale sources.
 *
 * Run: node scripts/generate-locale-json.mjs
 *
 * This script reads the TS locale files and writes their JSON equivalents
 * so the Rust i18n engine can load them directly without runtime serialization.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Locale source definitions ────────────────────────────────────────────────
// Each entry: { tsPath: path to the TS file, outDir: directory for the JSON file }

const LOCALE_SOURCES = [
  // agent-core
  { en: 'packages/agent-core/src/i18n-locales/en.ts', zh: 'packages/agent-core/src/i18n-locales/zh.ts', out: 'packages/agent-core/src/i18n-locales' },
  // kimi-code
  { en: 'apps/kimi-code/src/i18n/locales/en.ts', zh: 'apps/kimi-code/src/i18n/locales/zh.ts', out: 'apps/kimi-code/src/i18n/locales' },
  // kap-server
  { en: 'packages/kap-server/src/i18n-locales/en.ts', zh: 'packages/kap-server/src/i18n-locales/zh.ts', out: 'packages/kap-server/src/i18n-locales' },
  // kimi-inspect
  { en: 'apps/kimi-inspect/src/i18n/locales/en.ts', zh: 'apps/kimi-inspect/src/i18n/locales/zh.ts', out: 'apps/kimi-inspect/src/i18n/locales' },
  // vis/web
  { en: 'apps/vis/web/src/i18n/locales/en.ts', zh: 'apps/vis/web/src/i18n/locales/zh.ts', out: 'apps/vis/web/src/i18n/locales' },
];

// We need to use tsx or ts-node to load TS files. Try tsx first.
let loadTs;
try {
  const tsxRequire = createRequire(resolve(ROOT, 'node_modules', 'tsx'));
  loadTs = (path) => tsxRequire(path);
} catch {
  // Fallback: try to strip TS and use node directly (won't work for complex TS)
  console.error('tsx not available — install it with: pnpm add -D tsx');
  process.exit(1);
}

let generated = 0;

for (const source of LOCALE_SOURCES) {
  const enPath = resolve(ROOT, source.en);
  const zhPath = resolve(ROOT, source.zh);
  const outDir = resolve(ROOT, source.out);

  try {
    const enModule = loadTs(enPath);
    const zhModule = loadTs(zhPath);

    const enData = enModule.default || enModule;
    const zhData = zhModule.default || zhModule;

    mkdirSync(outDir, { recursive: true });

    writeFileSync(resolve(outDir, 'en.json'), JSON.stringify(enData, null, 2));
    writeFileSync(resolve(outDir, 'zh.json'), JSON.stringify(zhData, null, 2));

    const enKeys = Object.keys(enData).length;
    const zhKeys = Object.keys(zhData).length;
    console.log(`✓ ${source.out}/en.json (${enKeys} top keys)`);
    console.log(`✓ ${source.out}/zh.json (${zhKeys} top keys)`);
    generated++;
  } catch (err) {
    console.error(`✗ ${source.out}: ${err.message}`);
  }
}

console.log(`\nDone. Generated ${generated * 2} JSON locale files.`);