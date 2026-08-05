#!/usr/bin/env node

/**
 * Check locale files for malformed i18n placeholders.
 *
 * Validates that all `{{...}}` placeholders in en.ts/zh.ts locale files are
 * properly closed (no missing `}`) and that en/zh use the same placeholder
 * names for corresponding keys.
 *
 * Usage: node scripts/check-locale-placeholders.cjs
 *
 * Exit code 0 = all good, 1 = issues found.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ── Placeholder extraction ──────────────────────────────────────────────────

/** Matches all {{...}} placeholders (well-formed or not). */
const PLACEHOLDER_ANY = /\{\{[^}]*\}?\}?/g;

/** Matches only well-formed {{name}} placeholders. */
const PLACEHOLDER_WELL_FORMED = /\{\{(\w+)\}\}/g;

/** Matches likely broken placeholders: {{...} (missing closing }) or {{...}} (extra }). */
const PLACEHOLDER_BROKEN = /\{\{[^}]*\}(?!\})|\{\{[^}]*\}\}/g;

/**
 * Recursively collect all string values in a locale object, recording the
 * dot-path key for each.
 */
function collectStrings(obj, prefix = '') {
  const results = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      results.push({ path, value });
    } else if (typeof value === 'object' && value !== null) {
      results.push(...collectStrings(value, path));
    }
  }
  return results;
}

/**
 * Check a single locale file for malformed placeholders.
 * Returns an array of error messages.
 */
function checkPlaceholders(filePath) {
  const errors = [];

  // We need to load the TS file. Since this is a CJS script, we use require()
  // which works for TS files in this monorepo thanks to tsx registration.
  let data;
  try {
    // Clear require cache so we always get fresh data
    delete require.cache[require.resolve(filePath)];
    const mod = require(filePath);
    data = mod.default || mod;
  } catch (error) {
    errors.push(`Failed to load ${filePath}: ${error.message}`);
    return errors;
  }

  const strings = collectStrings(data);

  for (const { path, value } of strings) {
    // Check for broken/unclosed placeholders
    const opens = (value.match(/\{\{/g) || []).length;
    const closes = (value.match(/\}\}/g) || []).length;

    if (opens !== closes) {
      errors.push(
        `${filePath} → ${path}: mismatched placeholder braces ` +
        `({{ count: ${opens}, }} count: ${closes}) in "${value.slice(0, 60)}${value.length > 60 ? '...' : ''}"`,
      );
    }
  }

  return errors;
}

/**
 * Check that en and zh locale files use the same placeholder names for
 * corresponding keys.
 */
function checkPlaceholderParity(enPath, zhPath) {
  const errors = [];

  let enData, zhData;
  try {
    delete require.cache[require.resolve(enPath)];
    delete require.cache[require.resolve(zhPath)];
    enData = (require(enPath)).default || require(enPath);
    zhData = (require(zhPath)).default || require(zhPath);
  } catch (error) {
    // Skip parity check if files can't be loaded (already reported above)
    return errors;
  }

  const enStrings = collectStrings(enData);
  const zhStrings = collectStrings(zhData);

  const enMap = new Map(enStrings.map(s => [s.path, s.value]));
  const zhMap = new Map(zhStrings.map(s => [s.path, s.value]));

  // Check keys present in en but missing or different placeholders in zh
  for (const [key, enValue] of enMap) {
    const zhValue = zhMap.get(key);
    if (zhValue === undefined) continue; // missing key handled by type check

    const enPlaceholders = [...enValue.matchAll(PLACEHOLDER_WELL_FORMED)].map(m => m[1]).toSorted();
    const zhPlaceholders = [...zhValue.matchAll(PLACEHOLDER_WELL_FORMED)].map(m => m[1]).toSorted();

    if (enPlaceholders.length > 0 && JSON.stringify(enPlaceholders) !== JSON.stringify(zhPlaceholders)) {
      errors.push(
        `${path.basename(zhPath)} → ${key}: placeholder mismatch\n` +
        `  en: {{${enPlaceholders.join('}}, {{')}}}\n` +
        `  zh: {{${zhPlaceholders.join('}}, {{')}}}`,
      );
    }
  }

  return errors;
}

// ── Main ────────────────────────────────────────────────────────────────────

const LOCALE_PAIRS = [
  { en: 'packages/i18n/src/locales/en.ts', zh: 'packages/i18n/src/locales/zh.ts' },
  { en: 'packages/agent-core/src/i18n-locales/en.ts', zh: 'packages/agent-core/src/i18n-locales/zh.ts' },
  { en: 'apps/kimi-code/src/i18n/locales/en.ts', zh: 'apps/kimi-code/src/i18n/locales/zh.ts' },
  { en: 'packages/kap-server/src/i18n-locales/en.ts', zh: 'packages/kap-server/src/i18n-locales/zh.ts' },
  { en: 'apps/kimi-inspect/src/i18n/locales/en.ts', zh: 'apps/kimi-inspect/src/i18n/locales/zh.ts' },
  { en: 'apps/vis/web/src/i18n/locales/en.ts', zh: 'apps/vis/web/src/i18n/locales/zh.ts' },
  { en: 'apps/vscode/webview-ui/src/i18n/locales/en.ts', zh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts' },
];

let totalErrors = 0;

for (const pair of LOCALE_PAIRS) {
  const enPath = path.resolve(ROOT, pair.en);
  const zhPath = path.resolve(ROOT, pair.zh);

  // Skip sources whose files no longer exist (e.g. a retired package),
  // mirroring the other check scripts' `existsSync` tolerance.
  if (!fs.existsSync(enPath) || !fs.existsSync(zhPath)) {
    console.log(`⚠ ${pair.en.replace(/\/en\.ts$/, '')}: locale files not found — skipping`);
    continue;
  }

  // Individual placeholder format checks
  const enErrors = checkPlaceholders(enPath);
  const zhErrors = checkPlaceholders(zhPath);

  // Cross-locale parity check
  const parityErrors = checkPlaceholderParity(enPath, zhPath);

  const allErrors = [...enErrors, ...zhErrors, ...parityErrors];
  totalErrors += allErrors.length;

  for (const err of allErrors) {
    console.error(`✗ ${err}`);
  }

  if (allErrors.length === 0) {
    const enRel = pair.en.replace(/\/en\.ts$/, '');
    console.log(`✓ ${enRel}: placeholders OK`);
  }
}

if (totalErrors > 0) {
  console.error(`\n✗ Found ${totalErrors} placeholder issue(s).`);
  process.exit(1);
} else {
  console.log(`\n✓ All locale placeholders are well-formed and consistent.`);
  process.exit(0);
}
