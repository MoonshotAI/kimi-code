/**
 * Generate JSON locale files from TypeScript locale sources.
 *
 * Usage: pnpm run generate:locale-json
 *
 * Reads each TS locale file and writes its JSON equivalent so the
 * Rust i18n engine can load them directly without runtime serialization.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ── Locale source definitions ────────────────────────────────────────────────
// Each entry: { en, zh, out, extract? }
// extract is a function that extracts the locale data from the loaded module.

const LOCALE_SOURCES = [
  // Simple case: default export is the locale data object
  { en: 'packages/agent-core/src/i18n-locales/en.ts', zh: 'packages/agent-core/src/i18n-locales/zh.ts', out: 'packages/agent-core/src/i18n-locales' },
  { en: 'apps/kimi-code/src/i18n/locales/en.ts', zh: 'apps/kimi-code/src/i18n/locales/zh.ts', out: 'apps/kimi-code/src/i18n/locales' },
  { en: 'packages/kap-server/src/i18n-locales/en.ts', zh: 'packages/kap-server/src/i18n-locales/zh.ts', out: 'packages/kap-server/src/i18n-locales' },
  { en: 'apps/kimi-inspect/src/i18n/locales/en.ts', zh: 'apps/kimi-inspect/src/i18n/locales/zh.ts', out: 'apps/kimi-inspect/src/i18n/locales' },
  { en: 'apps/vis/web/src/i18n/locales/en.ts', zh: 'apps/vis/web/src/i18n/locales/zh.ts', out: 'apps/vis/web/src/i18n/locales' },
  { en: 'apps/vscode/webview-ui/src/i18n/locales/en.ts', zh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts', out: 'apps/vscode/webview-ui/src/i18n/locales' },
  // kimi-web: index.ts exports { messages: { en: {...}, zh: {...} } }
  {
    src: 'apps/kimi-web/src/i18n/locales/index.ts',
    out: 'apps/kimi-web/src/i18n/locales',
    extract: (mod) => {
      const m = mod.default || mod;
      // If the module has a `messages` property with `en` and `zh`, use that
      if (m.messages && m.messages.en && m.messages.zh) {
        return { en: m.messages.en, zh: m.messages.zh };
      }
      // If we got a combined object with top-level `en` and `zh` keys
      if (m.en && m.zh) {
        return { en: m.en, zh: m.zh };
      }
      throw new Error('Cannot extract en/zh from module');
    },
  },
];

let generated = 0;

for (const source of LOCALE_SOURCES) {
  // Determine paths based on whether this is a simple or complex entry
  let enPath, zhPath, outDir, extractFn;

  if (source.extract) {
    // Complex entry: single src file, extract function
    enPath = path.resolve(ROOT, source.src);
    zhPath = enPath; // same file
    outDir = path.resolve(ROOT, source.out);
    extractFn = source.extract;
  } else {
    enPath = path.resolve(ROOT, source.en);
    zhPath = path.resolve(ROOT, source.zh);
    outDir = path.resolve(ROOT, source.out);
    extractFn = (mod) => ({ en: mod.default || mod, zh: null }); // will be replaced
  }

  try {
    const enModule = require(enPath);

    let enData, zhData;

    if (source.extract) {
      // Use the extract function to get both en and zh from the same module
      const extracted = extractFn(enModule);
      enData = extracted.en;
      zhData = extracted.zh;
    } else {
      const zhModule = require(zhPath);
      enData = enModule.default || enModule;
      zhData = zhModule.default || zhModule;
    }

    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.resolve(outDir, 'en.json'), JSON.stringify(enData, null, 2) + '\n');
    fs.writeFileSync(path.resolve(outDir, 'zh.json'), JSON.stringify(zhData, null, 2) + '\n');

    const enSize = fs.statSync(path.resolve(outDir, 'en.json')).size;
    const zhSize = fs.statSync(path.resolve(outDir, 'zh.json')).size;
    console.log(`✓ ${source.out}/en.json (${(enSize / 1024).toFixed(0)} KB)`);
    console.log(`✓ ${source.out}/zh.json (${(zhSize / 1024).toFixed(0)} KB)`);
    generated++;
  } catch (err) {
    console.error(`✗ ${source.out}: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
  }
}

console.log(`\nDone. Generated ${generated * 2} JSON locale files.`);