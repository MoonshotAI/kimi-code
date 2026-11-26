#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { parseSync } from 'oxc-parser';

import { reportChanges, runCountCheck, trackedFiles } from './ratchet.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/app-boundaries.mjs';
const BASELINE_FILE = 'scripts/checks/baselines/app-boundaries.json';
const APP_PACKAGES = ['app-core', 'app-client', 'app-components', 'app-composer', 'app-markdown', 'app-ui', 'app-i18n'];
const SCAN_PREFIXES = ['apps/desktop/src/', ...APP_PACKAGES.map((pkg) => `packages/${pkg}/src/`)];
const SOURCE_FILE = /\.(?:ts|tsx|vue)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|e2e|__tests__|testing)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const STORES_PREFIX = 'packages/app-client/src/stores/';
const STORES_INFRA = new Set(['packages/app-client/src/stores/index.ts', 'packages/app-client/src/stores/pinia.ts']);
const BROWSER_VIEW_PREFIXES = ['/components/browser/', '/components/browser-overlay/'];
const SCRIPT_BLOCK = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/g;
const DIRECT_API_CALL = /(?<![\w.$])(?:getKimiWebApi|getDeviceApi|fetch)\s*\(/g;
const DIRECT_IPC_ACCESS = /\bwindow\.kimiDesktop\b|(?<![\w.$])(?:getNativeBrowserBridge|getDesktopBridge)\s*\(/g;

export const BOUNDARY_RULES = {
  'self-package-import': {
    what: 'a module importing its own package name instead of a relative path',
    instead: 'import sibling modules by relative path so package barrels do not pull the whole package into internal cycles',
  },
  'upward-package-import': {
    what: 'a lower-level package importing an upper-level package or app-core/api',
    instead: 'move shared primitives, contracts and UI helpers down to app-core/lib, app-core/contracts or app-ui',
  },
  'store-cross-import': {
    what: 'a Pinia store importing another store (stores/index.ts and stores/pinia.ts excepted)',
    instead: 'keep stores as isolated state containers and compose them in business hooks under src/composables',
  },
  'view-direct-api': {
    what: 'a Vue component calling getKimiWebApi, getDeviceApi or fetch directly',
    instead: 'move data fetching into a business hook and let the component compose the hook',
  },
  'view-direct-ipc': {
    what: 'a non-browser Vue component touching window.kimiDesktop or a native bridge directly',
    instead: 'wrap platform calls in a renderer hook and let the component compose the hook',
  },
  'runtime-cycle': {
    what: 'membership in a runtime import cycle (the count is the cycle size; type-only edges do not count)',
    instead: 'extract the shared state or contract into a leaf module that neither side imports back from',
  },
};

const UPWARD_FORBIDDEN = {
  'app-ui': /^app-(?:client|components|markdown|composer)$/,
  'app-markdown': /^app-(?:client|components)$/,
  'app-composer': /^app-(?:client|components|markdown|ui)$/,
  'app-i18n': /^app-(?:core|client|components|composer|markdown|ui)$/,
  'desktop:shared': /^app-(?:client|components|markdown|ui|composer)$/,
  'desktop:main': /^app-(?:client|components|markdown|ui|composer)$/,
};

export function isCheckedFile(file) {
  return (
    SOURCE_FILE.test(file) &&
    !file.endsWith('.d.ts') &&
    !TEST_FILE.test(file) &&
    !file.includes('node_modules/') &&
    SCAN_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

export function packageOfFile(file) {
  if (file.startsWith('apps/desktop/src/main/')) return 'desktop:main';
  if (file.startsWith('apps/desktop/src/renderer/')) return 'desktop:renderer';
  if (file.startsWith('apps/desktop/src/shared/')) return 'desktop:shared';
  return /^packages\/(app-[a-z0-9]+)\//.exec(file)?.[1];
}

export function scriptBlocks(file, text) {
  if (!file.endsWith('.vue')) return [{ code: text, lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }];
  return [...text.matchAll(SCRIPT_BLOCK)].map((match) => ({
    code: match[2],
    lang: /\blang\s*=\s*['"]tsx['"]/.test(match[1]) ? 'tsx' : 'ts',
  }));
}

function isTypeOnlyStatement(statement) {
  if (statement.type === 'ImportDeclaration') {
    if (statement.importKind === 'type') return true;
    const specifiers = statement.specifiers ?? [];
    return specifiers.length > 0 && specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type');
  }
  if (statement.type === 'ExportNamedDeclaration') {
    if (statement.exportKind === 'type') return true;
    const specifiers = statement.specifiers ?? [];
    return specifiers.length > 0 && specifiers.every((s) => s.exportKind === 'type');
  }
  if (statement.type === 'ExportAllDeclaration') {
    return statement.exportKind === 'type';
  }
  return false;
}

export function extractImports(file, text) {
  const imports = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      typeof node.source?.value === 'string'
    ) {
      imports.push({ specifier: node.source.value, typeOnly: isTypeOnlyStatement(node) });
      return;
    }
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') {
      imports.push({ specifier: node.source.value, typeOnly: false });
      return;
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') visit(value);
    }
  };
  for (const [index, { code, lang }] of scriptBlocks(file, text).entries()) {
    const virtualFile = file.endsWith('.vue') ? `${file}#script-${index}.${lang}` : file;
    const { program, errors } = parseSync(virtualFile, code);
    if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
    visit(program.body);
  }
  return imports;
}

export function findRuntimeCycles(files, edges) {
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let nextIndex = 0;

  const visit = (file) => {
    indices.set(file, nextIndex);
    low.set(file, nextIndex);
    nextIndex += 1;
    stack.push(file);
    onStack.add(file);
    for (const target of edges.get(file) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(file, Math.min(low.get(file), indices.get(target)));
      }
    }
    if (low.get(file) === indices.get(file)) {
      const cycle = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        cycle.push(member);
      } while (member !== file);
      if (cycle.length > 1) cycles.push(cycle.toSorted((a, b) => a.localeCompare(b)));
    }
  };

  for (const file of files) {
    if (!indices.has(file)) visit(file);
  }
  return cycles.toSorted((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function isBrowserView(file) {
  return BROWSER_VIEW_PREFIXES.some((prefix) => file.includes(prefix));
}

export function countBoundaries({ files, readText, resolveTarget }) {
  const counts = {};
  const fileSet = new Set(files);
  const edges = new Map(files.map((file) => [file, new Set()]));
  const add = (rule, file, count = 1) => {
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + count;
  };

  for (const file of files) {
    const text = readText(file);
    const fromPkg = packageOfFile(file);
    for (const { specifier, typeOnly } of extractImports(file, text)) {
      const target = resolveTarget(specifier, file);
      if (target === undefined) continue;
      const { targetFile, targetPkg } = target;
      if (fromPkg !== undefined && targetPkg === fromPkg && specifier.startsWith('@moonshot-ai/')) {
        add('self-package-import', file);
      }
      if (fromPkg === 'app-ui' && targetPkg === 'app-core' && specifier.startsWith('@moonshot-ai/app-core/api')) {
        add('upward-package-import', file);
      }
      if (targetPkg !== undefined && targetPkg !== fromPkg && UPWARD_FORBIDDEN[fromPkg]?.test(targetPkg)) {
        add('upward-package-import', file);
      }
      if (
        file.startsWith(STORES_PREFIX) &&
        !STORES_INFRA.has(file) &&
        targetFile?.startsWith(STORES_PREFIX) &&
        !STORES_INFRA.has(targetFile) &&
        targetFile !== file
      ) {
        add('store-cross-import', file);
      }
      if (!typeOnly && targetFile !== undefined && targetFile !== file && fileSet.has(targetFile)) {
        edges.get(file).add(targetFile);
      }
    }
    if (file.endsWith('.vue') && !isBrowserView(file)) {
      const script = scriptBlocks(file, text).map((block) => block.code).join('\n');
      const apiCalls = [...script.matchAll(DIRECT_API_CALL)].length;
      if (apiCalls > 0) add('view-direct-api', file, apiCalls);
      const ipcCalls = [...script.matchAll(DIRECT_IPC_ACCESS)].length;
      if (ipcCalls > 0) add('view-direct-ipc', file, ipcCalls);
    }
  }

  for (const cycle of findRuntimeCycles(files, edges)) {
    for (const file of cycle) add('runtime-cycle', file, cycle.length);
  }
  return counts;
}

function resolveOnDisk(root, base) {
  const withoutJs = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;
  const candidates = [
    base,
    withoutJs,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}.vue`,
    join(withoutJs, 'index.ts'),
    join(withoutJs, 'index.vue'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).split('\\').join('/');
    }
  }
  return undefined;
}

export function createDiskResolver(root, packages = APP_PACKAGES) {
  const entries = packages.map((pkg) => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'));
    return [`@moonshot-ai/${pkg}`, pkg, manifest.exports ?? {}];
  });
  return (specifier, fromFile) => {
    if (specifier.startsWith('.')) {
      const targetFile = resolveOnDisk(root, resolve(dirname(join(root, fromFile)), specifier));
      if (targetFile === undefined) return undefined;
      return { targetFile, targetPkg: packageOfFile(targetFile) };
    }
    for (const [prefix, pkg, exportsMap] of entries) {
      if (specifier !== prefix && !specifier.startsWith(`${prefix}/`)) continue;
      const subpath = specifier === prefix ? '.' : `.${specifier.slice(prefix.length)}`;
      const entry = exportsMap[subpath];
      const targetFile = typeof entry === 'string' ? resolveOnDisk(root, resolve(root, 'packages', pkg, entry)) : undefined;
      return { targetFile, targetPkg: pkg };
    }
    return undefined;
  };
}

export function formatReport(changes) {
  return reportChanges(changes, {
    added: (added) => [
      '✗ app-boundaries: new Desktop / app-* boundary violations',
      ...added.flatMap((change) => {
        const rule = BOUNDARY_RULES[change.rule];
        return [
          `  ${change.rule} in ${change.file}: ${change.from} → ${change.to} (${rule?.what ?? change.rule})`,
          `    instead: ${rule?.instead ?? 'keep the dependency direction one-way'}`,
        ];
      }),
      '  Why: Desktop UI composes business hooks, Pinia stores stay isolated, and lower-level packages never depend on upper-level ones. Existing violations are frozen per file so refactoring can ratchet them down without new ones slipping in.',
      `  What to do: fix the new violation. If you only moved existing code between files, run \`node ${CHECK_FILE} --update --allow-increase\` and say so in the PR.`,
    ],
    removed: (removed) => [
      `✗ app-boundaries: ${BASELINE_FILE} allows more violations than the code has`,
      ...removed.map((change) => `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down, so cleaned-up cycles and cross-layer imports cannot come back unnoticed.',
      `  What to do: run \`node ${CHECK_FILE} --update\` and commit the baseline.`,
    ],
  });
}

export function main(args) {
  return runCountCheck({
    name: 'app-boundaries',
    root: ROOT,
    checkFile: CHECK_FILE,
    baselineFile: BASELINE_FILE,
    args,
    measure: () => {
      const files = trackedFiles(ROOT, isCheckedFile);
      return countBoundaries({
        files,
        readText: (file) => readFileSync(join(ROOT, file), 'utf8'),
        resolveTarget: createDiskResolver(ROOT),
      });
    },
    formatReport,
    summary: (counts) => {
      const perRule = Object.entries(counts)
        .map(([rule, byFile]) => `${rule}=${Object.keys(byFile).length}`)
        .join(', ');
      return `existing Desktop / app-* boundary violations frozen (${perRule || 'none'}); no new violations`;
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
