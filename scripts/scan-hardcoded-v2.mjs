#!/usr/bin/env node
/**
 * scan-hardcoded-v2.mjs — Enhanced hardcoded string scanner.
 *
 * Strategy: Load each module's existing locale file, extract all leaf values
 * (the actual translated text), then search the source code for those exact
 * strings appearing OUTSIDE a t() call. If a string exists in the locale file
 * but is hardcoded in source, it should be replaced with t('key').
 *
 * Also catches common patterns like throw new Error() with user-facing text.
 *
 * Usage:
 *   node scripts/scan-hardcoded-v2.mjs                     # scan all modules
 *   node scripts/scan-hardcoded-v2.mjs --module agent-core  # scan one module
 *   node scripts/scan-hardcoded-v2.mjs --output reports/scan.json
 *
 * Exit code: 0 if no issues found, 1 if any found.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', '.vite', '.cache',
  'coverage', '__snapshots__',
]);

// Module definitions
const MODULES = [
  {
    name: 'agent-core',
    srcDir: 'packages/agent-core/src',
    localeDir: 'packages/i18n/src/locales',
    localeEn: 'packages/i18n/src/locales/en.ts',
    localeZh: 'packages/i18n/src/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /t\b.*from\s+['"]@moonshot-ai\/kimi-i18n['"]/,
    skipDirs: ['i18n-locales'],
    fileTypes: ['.ts'],
    tImportName: 't',
  },
  {
    name: 'kap-server',
    srcDir: 'packages/kap-server/src',
    localeDir: 'packages/i18n/src/locales',
    localeEn: 'packages/i18n/src/locales/en.ts',
    localeZh: 'packages/i18n/src/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /t\b.*from\s+['"]@moonshot-ai\/kimi-i18n['"]/,
    skipDirs: ['i18n-locales'],
    fileTypes: ['.ts'],
    tImportName: 't',
  },
  {
    name: 'kimi-code',
    srcDir: 'apps/kimi-code/src',
    localeDir: 'apps/kimi-code/src/i18n/locales',
    localeEn: 'apps/kimi-code/src/i18n/locales/en.ts',
    localeZh: 'apps/kimi-code/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"]#\/i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts'],
    tImportName: 't',
  },
  {
    name: 'kimi-web',
    srcDir: 'apps/kimi-web/src',
    localeDir: 'apps/kimi-web/src/i18n/locales',
    localeEn: 'apps/kimi-web/src/i18n/locales/en.json',
    localeZh: 'apps/kimi-web/src/i18n/locales/zh.json',
    localeIsJson: true,
    tPattern: /\$t\(['"]/,
    importPattern: /useI18n/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx', '.vue'],
    tImportName: '$t',
  },
  {
    name: 'kimi-inspect',
    srcDir: 'apps/kimi-inspect/src',
    localeDir: 'apps/kimi-inspect/src/i18n/locales',
    localeEn: 'apps/kimi-inspect/src/i18n/locales/en.ts',
    localeZh: 'apps/kimi-inspect/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
  {
    name: 'vis-web',
    srcDir: 'apps/vis/web/src',
    localeDir: 'apps/vis/web/src/i18n/locales',
    localeEn: 'apps/vis/web/src/i18n/locales/en.ts',
    localeZh: 'apps/vis/web/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
  {
    name: 'vscode-webview',
    srcDir: 'apps/vscode/webview-ui/src',
    localeDir: 'apps/vscode/webview-ui/src/i18n/locales',
    localeEn: 'apps/vscode/webview-ui/src/i18n/locales/en.ts',
    localeZh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
];

// ── TS module loader ───────────────────────────────────────────────────────

let tsxRegistered = false;
function ensureTsx() {
  if (tsxRegistered) return;
  try {
    register('tsx/esm', pathToFileURL(import.meta.url));
    tsxRegistered = true;
  } catch {
    // tsx not available
  }
}

async function loadTSModule(p) {
  ensureTsx();
  const fullPath = resolve(ROOT, p);
  const fileUrl = pathToFileURL(fullPath).href;
  try {
    const mod = await import(fileUrl);
    return mod.default || mod;
  } catch (err) {
    throw new Error(`Cannot load ${p}: ${err.message}`);
  }
}

// ── Locale key/value extraction ────────────────────────────────────────────

function collectLeaves(obj, prefix = '') {
  const entries = [];
  if (obj === null || typeof obj !== 'object') return entries;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      entries.push(...collectLeaves(value, fullKey));
    } else if (typeof value === 'string') {
      entries.push({ key: fullKey, value });
    }
  }
  return entries;
}

/**
 * Extract locale values from a TS module or JSON file.
 */
async function extractLocaleValues(modInfo) {
  let enData, zhData;

  if (modInfo.localeIsJson) {
    // JSON files — load directly
    const enPath = resolve(ROOT, modInfo.localeEn);
    const zhPath = resolve(ROOT, modInfo.localeZh);
    const enContent = readFileSync(enPath, 'utf-8');
    const zhContent = readFileSync(zhPath, 'utf-8');
    enData = JSON.parse(enContent);
    zhData = JSON.parse(zhContent);
  } else {
    // TS module — import via tsx
    enData = await loadTSModule(modInfo.localeEn);
    zhData = await loadTSModule(modInfo.localeZh);
  }

  const enLeaves = enData ? collectLeaves(enData) : [];
  const zhLeaves = zhData ? collectLeaves(zhData) : [];

  // Build a map from leaf value → [keys] (one value might appear under multiple keys)
  const valueToKeys = new Map();
  for (const entry of [...enLeaves, ...zhLeaves]) {
    const normalized = entry.value.trim().replace(/\{\{(\w+)\}\}/g, '*'); // normalize params
    if (!valueToKeys.has(normalized)) {
      valueToKeys.set(normalized, []);
    }
    valueToKeys.get(normalized).push(entry.key);
  }

  return { enLeaves, zhLeaves, valueToKeys };
}

// ── Scanner ────────────────────────────────────────────────────────────────

function scanFile(filePath, content, moduleInfo, valueToKeys) {
  const findings = [];
  const lines = content.split('\n');
  const relPath = relative(ROOT, filePath).replace(/\\/g, '/');

  // Check if file already imports/uses t()
  const tVarPattern = moduleInfo.tImportName === '$t' ? /\$t\b/ : /\bt\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (/^\s*(\/\/|\*|<!--)/.test(line)) continue;

    // ── Detection 1: Locale value appears hardcoded (not in t() call) ──
    // Only applies to files that already use t() — files without t() imports
    // are expected to have hardcoded strings (they may not be user-facing)
    const fileUsesT = tVarPattern.test(content);

    // Look for locale values appearing as string literals
    for (const [normalizedValue, keys] of valueToKeys) {
      // Skip single-word short values that look like identifiers, not display text
      const plainValue = normalizedValue.replace(/\*/g, '');
      if (plainValue.length < 5 && !/[\u4e00-\u9fff]/.test(plainValue)) continue;
      if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(plainValue) && plainValue.length < 20) continue;
      // Skip single-word PascalCase values (likely command names or identifiers)
      if (/^[A-Z][a-z]+$/.test(plainValue) && plainValue.length < 15) continue;
      // Skip single words without spaces (likely identifiers, not display text)
      if (!plainValue.includes(' ') && plainValue.length < 12 && !/[\u4e00-\u9fff]/.test(plainValue)) continue;

      // Build a regex from the value, escaping regex special chars
      const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Replace placeholder * with .+ for fuzzy matching
      const fuzzyPattern = escaped.replace(/\*/g, '.+?');
      const valueRegex = new RegExp(`['"\`]${fuzzyPattern}['"\`]`);

      if (valueRegex.test(trimmed)) {
        // Check if this string is already wrapped in t() or $t()
        const tCallRegex = new RegExp(
          `(?:\\bt\\(|\\$t\\(|t\\()['"\`]${fuzzyPattern}['"\`]`
        );
        if (tCallRegex.test(trimmed)) continue; // already using t()

        // Check if this line IS the locale definition itself
        if (relPath.includes(moduleInfo.name === 'kimi-web' ? '/locales/' : '/i18n')) continue;

        // Skip if it's in an import/require
        if (/^(import|require|from|export)/.test(trimmed)) continue;

        // Skip if it's a type/interface property definition
        if (/\w+\??:\s*string/.test(trimmed)) continue;

        findings.push({
          file: relPath,
          line: lineNum,
          type: 'hardcoded_locale_value',
          text: normalizedValue,
          keys,
          context: trimmed.substring(0, 100),
        });
      }
    }

    // ── Detection 2: throw new Error('user-facing message') that should use t() ──
    const errorMatches = trimmed.matchAll(/throw new Error\(['"]([^'"]{8,})['"]\)/g);
    for (const em of errorMatches) {
      const str = em[1].trim();
      // Skip error class names / PascalCase identifiers
      if (/^[A-Z][a-z]+Error$/.test(str)) continue;
      // Check if this string exists in locale values
      const normalized = str.replace(/\{\{(\w+)\}\}/g, '*');
      if (valueToKeys.has(normalized)) {
        findings.push({
          file: relPath,
          line: lineNum,
          type: 'throw_error_with_locale_key',
          text: str,
          keys: valueToKeys.get(normalized),
          context: trimmed.substring(0, 100),
        });
      } else if (looksLikeUserFacing(str)) {
        findings.push({
          file: relPath,
          line: lineNum,
          type: 'throw_error_hardcoded',
          text: str,
          keys: [],
          context: trimmed.substring(0, 100),
        });
      }
    }

    // ── Detection 3: String in chalk output context (kimi-code CLI) ──
    if (moduleInfo.name === 'kimi-code') {
      const chalkMatches = trimmed.matchAll(
        /(?:chalk|dim|bold|italic|hex|gray)\(['"]([^'"]{5,})['"]\)/g
      );
      for (const cm of chalkMatches) {
        const str = cm[1].trim();
        const normalized = str.replace(/\{\{(\w+)\}\}/g, '*');
        if (!valueToKeys.has(normalized) && looksLikeUserFacing(str)) {
          findings.push({
            file: relPath,
            line: lineNum,
            type: 'chalk_output_no_locale',
            text: str,
            keys: [],
            context: trimmed.substring(0, 100),
          });
        }
      }
    }
  }

  return findings;
}

function looksLikeUserFacing(str) {
  if (str.length < 5) return false;
  // Skip internal identifiers
  if (/^[A-Z][A-Z_]+$/.test(str)) return false;         // ALL_CAPS
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(str) && str.length < 24) return false; // snake/kebab
  // Must start with a capital letter (English) or contain Chinese
  return /^[A-Z]/.test(str) && /[a-z]/.test(str) || /[\u4e00-\u9fff]/.test(str);
}

function walkDir(dirPath, moduleInfo, valueToKeys) {
  const findings = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (moduleInfo.skipDirs?.includes(entry.name)) continue;
        findings.push(...walkDir(full, moduleInfo, valueToKeys));
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (moduleInfo.fileTypes.includes(ext)) {
          try {
            const content = readFileSync(full, 'utf-8');
            findings.push(...scanFile(full, content, moduleInfo, valueToKeys));
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // skip
  }
  return findings;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const moduleFilter = args.find((a) => a.startsWith('--module='))?.split('=')[1];
  const outputFile = args.find((a) => a.startsWith('--output='))?.split('=')[1];

  const modulesToScan = moduleFilter
    ? MODULES.filter((m) => m.name === moduleFilter)
    : MODULES;

  if (modulesToScan.length === 0) {
    console.error(`Unknown module: ${moduleFilter}`);
    process.exit(1);
  }

  const allResults = {};

  for (const mod of modulesToScan) {
    const srcDir = join(ROOT, mod.srcDir);
    if (!existsSync(srcDir)) {
      console.log(`[${mod.name}] Source dir not found: ${mod.srcDir}`);
      continue;
    }

    console.log(`\n=== Loading locale files for ${mod.name} ===`);
    let valueToKeys;
    try {
      const localeData = await extractLocaleValues(mod);
      valueToKeys = localeData.valueToKeys;
      console.log(`  en: ${localeData.enLeaves.length} keys, zh: ${localeData.zhLeaves.length} keys`);
      console.log(`  ${valueToKeys.size} unique value patterns`);
    } catch (err) {
      console.error(`  Failed to load locales: ${err.message}`);
      continue;
    }

    console.log(`\n=== Scanning ${mod.name} (${mod.srcDir}) ===`);
    const findings = walkDir(srcDir, mod, valueToKeys);
    console.log(`  Found ${findings.length} issues`);

    // Group by type
    const byType = {};
    for (const f of findings) {
      byType[f.type] = (byType[f.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type}: ${count}`);
    }

    // Show sample findings (up to 15)
    if (findings.length > 0) {
      console.log(`\n  Sample findings (up to 15):`);
      for (const f of findings.slice(0, 15)) {
        const keyInfo = f.keys.length > 0 ? ` → ${f.keys[0]}` : '';
        console.log(`    ${f.file}:${f.line} [${f.type}] "${f.text}"${keyInfo}`);
      }
      if (findings.length > 15) {
        console.log(`    ... and ${findings.length - 15} more`);
      }
    }

    allResults[mod.name] = findings;
  }

  // Save report
  if (outputFile) {
    const outputPath = resolve(ROOT, outputFile);
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`\nReport saved to: ${outputFile}`);
  }

  const totalFindings = Object.values(allResults).flat().length;
  console.log(`\nTotal: ${totalFindings} issues across ${Object.keys(allResults).length} modules`);
  process.exit(totalFindings > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});