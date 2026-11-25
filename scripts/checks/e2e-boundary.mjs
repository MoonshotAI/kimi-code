#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { parseSync } from 'oxc-parser';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/e2e-boundary.mjs';
const TABLE_FILE = 'scripts/checks/e2e-boundary.json';
const DOCS_FILE = 'docs/en/configuration/env-vars.md';
const E2E_ROOT = 'tests/e2e/';
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SCENARIO_ROOTS = ['tests/e2e/scenarios/', 'tests/e2e/self-test/'];
const SCENARIO_SUPPORT = ['tests/e2e/support/scenario', 'tests/e2e/support/scenario.ts'];
const TESTKIT_MODEL = '@moonshot-ai/testkit/model';
const TESTKIT_FIXTURES = '@moonshot-ai/testkit/fixtures';
const PLAYWRIGHT = '@playwright/test';
const KIMI_NAME = /KIMI_[A-Z0-9_]+/g;
const TABLE_RULE = 'exceptions';

const ALLOWED_EVERYWHERE = new Set([
  TESTKIT_MODEL,
  TESTKIT_FIXTURES,
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:stream',
  'node:url',
]);

const ALLOWED_ONLY_IN = {
  '@agentclientprotocol/sdk': ['tests/e2e/surfaces/acp.ts'],
  '@moonshot-ai/pi-tui/testing': ['tests/e2e/surfaces/tui.ts'],
  'node-pty': ['tests/e2e/surfaces/tui.ts'],
  'node:child_process': ['tests/e2e/surfaces/acp.ts'],
};

const USER_OPERATIONS = 'drive the product with user operations only: keys and screen reads, clicks and typing located by role and accessible name, or ACP messages as an editor sends them';

function literal(text) {
  return new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), 'g');
}

function pattern(label, instead, regex = literal(label)) {
  return { label, instead, regex };
}

const IN_PAGE = 'read the page through its accessibility tree and act with clicks and typing; do not run code inside the page or Electron';
const NO_INTERCEPT = 'let the product talk to the testkit fake model and its service stubs; do not intercept or fake network traffic';
const NO_TEST_HTTP = `${USER_OPERATIONS}; the test never sends HTTP itself or seeds browser state`;
const NO_PRODUCT_API = `${USER_OPERATIONS}; the test never calls the product's HTTP or WebSocket API`;
const NO_DEBUG_SWITCH = 'start the product the way a user does, with documented arguments and environment variables only';
const NO_URL_FLAG = 'open the URL the product prints and complete onboarding in the UI';
const NO_PAGE_GLOBAL = 'observe state through what the UI shows, not through page globals or browser storage';

export const BACKDOOR_PATTERNS = [
  pattern('.evaluate(', IN_PAGE),
  pattern('.evaluateHandle(', IN_PAGE),
  pattern('.$eval(', IN_PAGE),
  pattern('.$$eval(', IN_PAGE),
  pattern('.addInitScript(', IN_PAGE),
  pattern('.exposeFunction(', IN_PAGE),
  pattern('.exposeBinding(', IN_PAGE),
  pattern('.route(', NO_INTERCEPT),
  pattern('.routeWebSocket(', NO_INTERCEPT),
  pattern('.routeFromHAR(', NO_INTERCEPT),
  pattern('APIRequestContext', NO_TEST_HTTP, /\bAPIRequestContext\b/g),
  pattern('.request.', NO_TEST_HTTP),
  pattern('request.newContext', NO_TEST_HTTP, /\brequest\.newContext\b/g),
  pattern('.setExtraHTTPHeaders(', NO_TEST_HTTP),
  pattern('.addCookies(', NO_TEST_HTTP),
  pattern('storageState', NO_TEST_HTTP, /\bstorageState\b/g),
  pattern('.dispatchEvent(', NO_TEST_HTTP),
  pattern('fetch(', NO_PRODUCT_API, /\bfetch\s*\(|\.fetch\b/g),
  pattern('WebSocket', NO_PRODUCT_API),
  pattern('/api/v1', NO_PRODUCT_API),
  pattern('/openapi.json', NO_PRODUCT_API),
  pattern('/asyncapi.json', NO_PRODUCT_API),
  pattern('Authorization', NO_PRODUCT_API, /\bAuthorization\b/g),
  pattern('Bearer ', NO_PRODUCT_API, /\bBearer /g),
  pattern('kimi-code.bearer.', NO_PRODUCT_API),
  pattern('server.token', NO_PRODUCT_API),
  pattern('--debug-endpoints', NO_DEBUG_SWITCH, /(?<![\w-])--debug-endpoints(?![\w-])/g),
  pattern('--dangerous-bypass-auth', NO_DEBUG_SWITCH, /(?<![\w-])--dangerous-bypass-auth(?![\w-])/g),
  pattern('--socket', NO_DEBUG_SWITCH, /(?<![\w-])--socket(?![\w-])/g),
  pattern('--allow-remote-shutdown', NO_DEBUG_SWITCH, /(?<![\w-])--allow-remote-shutdown(?![\w-])/g),
  pattern('KIMI_CODE_DISABLE_HOST_CHECK', NO_DEBUG_SWITCH, /\bKIMI_CODE_DISABLE_HOST_CHECK\b/g),
  pattern('KIMI_CODE_CORS_ORIGINS', NO_DEBUG_SWITCH, /\bKIMI_CODE_CORS_ORIGINS\b/g),
  pattern('kimi_onboarded', NO_URL_FLAG, /\bkimi_onboarded\b/g),
  pattern('kimi_desktop', NO_URL_FLAG, /\bkimi_desktop\b/g),
  pattern('kimi_origin', NO_URL_FLAG, /\bkimi_origin\b/g),
  pattern('kimi_embedded', NO_URL_FLAG, /\bkimi_embedded\b/g),
  pattern('kimi_native_titlebar', NO_URL_FLAG, /\bkimi_native_titlebar\b/g),
  pattern('__kimiApi', NO_PAGE_GLOBAL),
  pattern('kimiDesktop', NO_PAGE_GLOBAL, /\bkimiDesktop\b/g),
  pattern('localStorage', NO_PAGE_GLOBAL, /\blocalStorage\b/g),
  pattern('sessionStorage', NO_PAGE_GLOBAL, /\bsessionStorage\b/g),
];

const NOT_APPLICABLE = 'declare a surface that does not apply with except or onlyOn and a reason in scenario(); every other case runs on every surface';
const WAIT_FOR_CONDITION = 'wait for a condition with until() or expect.poll, and pace the fake model with after() or paced()';
const NO_RETRY = 'keep retries at 0 and fix the root cause of a flaky case';

export const FLAKE_MASKING_PATTERNS = [
  pattern('.skip(', NOT_APPLICABLE),
  pattern('.fixme(', NOT_APPLICABLE),
  pattern('.fail(', NOT_APPLICABLE),
  pattern('.only(', 'run one case with a file path or --grep on the command line instead of committing .only'),
  pattern('retries', NO_RETRY, /\bretries\b\s*(?::(?!\s*0(?![\d.]))|=(?!=)|[,})])/g),
  pattern('waitForTimeout(', WAIT_FOR_CONDITION, /\bwaitForTimeout\(/g),
  pattern('setTimeout(', WAIT_FOR_CONDITION, /\bsetTimeout\(/g),
  pattern('setInterval(', WAIT_FOR_CONDITION, /\bsetInterval\(/g),
  pattern('sleep(', WAIT_FOR_CONDITION, /\bsleep\s*\(/g),
  pattern('Atomics.wait', WAIT_FOR_CONDITION, /\bAtomics\.wait\b/g),
  pattern('toPass(', `${WAIT_FOR_CONDITION}; toPass re-runs a block until it passes, which is a retry`, /\btoPass\(/g),
];

const SURFACE_BLIND = 'use only product, model and workspace; a difference between surfaces belongs in its driver, or in except/onlyOn with a reason';

export const SCENARIO_ENVIRONMENT_PATTERNS = [
  pattern('process.', SURFACE_BLIND, /\bprocess(?:\.[A-Za-z_$]|\[)/g),
  pattern('test.info(', SURFACE_BLIND, /\btest\.info\(/g),
  pattern('testInfo', SURFACE_BLIND, /\btestInfo\b/g),
];

const EXCEPTION_NOTE = `A genuine exception is registered in ${TABLE_FILE} with a reason and reviewed by CODEOWNERS.`;

const RULES = {
  imports: {
    title: 'tests/e2e imports a module outside its allowlist',
    why: 'Drivers must not cover for the product. Product internals, legacy fixtures and raw network modules let a driver reach the product in ways a user cannot, so a scenario passes while the path a user takes is broken. The list is an allowlist, so a new internal package is rejected by default.',
    fix: `Import only ${TESTKIT_MODEL}, ${TESTKIT_FIXTURES}, ${PLAYWRIGHT} (not in scenarios or self-tests), the allowed node: builtins, or a file inside tests/e2e. ${EXCEPTION_NOTE}`,
  },
  backdoor: {
    title: 'tests/e2e uses an entry point a user cannot reach',
    why: "Drivers must not cover for the product. Running code inside the page or Electron, faking network traffic, calling the product's HTTP or WebSocket API and debug launch switches all bypass the UI, so the scenario stays green when the user-facing path is broken.",
    fix: `Drive the product with user operations only. ${EXCEPTION_NOTE}`,
  },
  'no-flake-masking': {
    title: 'tests/e2e skips, retries or waits a fixed time',
    why: 'This masks flakiness. A skipped, retried or sleep-padded case stays green while the product or the driver is broken; in this suite every red result has to be real.',
    fix: `Wait for a condition instead of a duration, keep retries at 0, and find the root cause of a flaky case. ${EXCEPTION_NOTE}`,
  },
  'scenario-environment': {
    title: 'a scenario or self-test reads its environment',
    why: 'This weakens the shared UI assertions. A scenario that can see the surface name, the test info or the process environment can branch per surface, so the same scenario no longer checks the same behaviour everywhere.',
    fix: `Use only the product, model and workspace fixtures. ${EXCEPTION_NOTE}`,
  },
  'kimi-names': {
    title: 'tests/e2e uses a KIMI_* name that is not documented for users',
    why: `Drivers must not cover for the product. Setup may only use what a user can use, and ${DOCS_FILE} decides which variables are public; a test-only product switch can change the behaviour under test.`,
    fix: `Use a documented variable, or register the switch under testSwitches in ${TABLE_FILE} with the files that use it and a reason showing that it only changes environment-level side effects. CODEOWNERS review that table.`,
  },
  [TABLE_RULE]: {
    title: `${TABLE_FILE} has an invalid or stale entry`,
    why: 'Every exception weakens a rule for one file, so each one needs a stated reason and must still be in use; a stale entry would let the pattern come back unnoticed.',
    fix: 'Give the entry a non-empty reason, point it at an existing file under tests/e2e, or delete it once nothing needs it.',
  },
};

const EXCEPTABLE_RULES = ['imports', 'backdoor', 'no-flake-masking', 'scenario-environment'];

export function isCheckedFile(file) {
  return file.startsWith(E2E_ROOT) && SOURCE_FILE.test(file) && !file.includes('node_modules/');
}

function isScenarioFile(file) {
  return SCENARIO_ROOTS.some((root) => file.startsWith(root));
}

function lineAt(text, index) {
  let line = 1;
  for (let position = text.indexOf('\n'); position !== -1 && position < index; position = text.indexOf('\n', position + 1)) line += 1;
  return line;
}

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked;
  return undefined;
}

function isImportMetaResolve(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'MetaProperty' &&
    callee.object.meta.name === 'import' &&
    callee.object.property.name === 'meta' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'resolve'
  );
}

function referenceOf(node) {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'TSImportType':
      return { source: node.source };
    case 'ExportNamedDeclaration':
      return node.source === null ? undefined : { source: node.source };
    case 'TSImportEqualsDeclaration':
      return node.moduleReference.type === 'TSExternalModuleReference' ? { source: node.moduleReference.expression } : undefined;
    case 'ImportExpression':
      return { source: node.source, dynamic: 'import(' };
    case 'CallExpression':
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') return { source: node.arguments[0], dynamic: 'require(' };
      if (isImportMetaResolve(node.callee)) return { source: node.arguments[0] };
      return undefined;
    default:
      return undefined;
  }
}

function sleepNames(node) {
  if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration') return [];
  if (stringValue(node.source) !== TESTKIT_FIXTURES) return [];
  return node.specifiers.filter((specifier) => (specifier.imported ?? specifier.local)?.name === 'sleep');
}

export function moduleReferences(file, text) {
  const { program, errors } = parseSync(file, text);
  const references = [];
  const dynamic = [];
  const sleeps = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (typeof node.type === 'string') {
      const reference = referenceOf(node);
      const specifier = reference === undefined ? undefined : stringValue(reference.source);
      if (specifier !== undefined) references.push({ specifier, line: lineAt(text, node.start) });
      else if (reference?.dynamic !== undefined) dynamic.push({ call: reference.dynamic, line: lineAt(text, node.start) });
      for (const specifier of sleepNames(node)) sleeps.push({ line: lineAt(text, specifier.start) });
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return { references, dynamic, sleeps, parseErrors: errors.map((error) => error.message) };
}

function resolveRelative(file, specifier) {
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

function isRelative(specifier) {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function importProblem(file, specifier) {
  const relative = isRelative(specifier);
  const target = relative ? resolveRelative(file, specifier) : undefined;
  if (isScenarioFile(file)) {
    if (specifier === TESTKIT_MODEL || (target !== undefined && SCENARIO_SUPPORT.includes(target))) return undefined;
    return `scenarios and self-tests import only tests/e2e/support/scenario.ts and ${TESTKIT_MODEL}`;
  }
  if (relative) {
    if (target.startsWith(E2E_ROOT) && !target.includes('node_modules')) return undefined;
    return 'a relative import must stay inside tests/e2e; legacy fixtures and product sources are off limits';
  }
  if (specifier === PLAYWRIGHT || ALLOWED_EVERYWHERE.has(specifier)) return undefined;
  const owners = ALLOWED_ONLY_IN[specifier];
  if (owners === undefined) return `use ${TESTKIT_MODEL}, ${TESTKIT_FIXTURES} or an allowed node: builtin; product packages, legacy fixtures and network modules are off limits`;
  if (owners.includes(file)) return undefined;
  return `${specifier} is allowed only in ${owners.join(' and ')}; start other processes with TestProcess from ${TESTKIT_FIXTURES}`;
}

export function importFindings(file, text) {
  const { references, dynamic, sleeps, parseErrors } = moduleReferences(file, text);
  const findings = [];
  for (const message of parseErrors) {
    findings.push({ file, line: 1, rule: 'imports', pattern: 'parse error', match: message, instead: 'fix the syntax error so the imports of this file can be checked' });
  }
  for (const { specifier, line } of references) {
    const instead = importProblem(file, specifier);
    if (instead !== undefined) findings.push({ file, line, rule: 'imports', pattern: specifier, match: specifier, instead });
  }
  for (const { call, line } of dynamic) {
    findings.push({ file, line, rule: 'imports', pattern: call, match: `${call}…) with a computed specifier`, instead: 'pass one string literal so the specifier can be checked against the allowlist' });
  }
  for (const { line } of sleeps) {
    findings.push({ file, line, rule: 'no-flake-masking', pattern: 'sleep', match: `sleep from ${TESTKIT_FIXTURES}`, instead: WAIT_FOR_CONDITION });
  }
  return findings;
}

function textFindings(file, text, rule, patterns) {
  const findings = [];
  for (const { label, instead, regex } of patterns) {
    for (const found of text.matchAll(regex)) {
      findings.push({ file, line: lineAt(text, found.index), rule, pattern: label, match: found[0], instead });
    }
  }
  return findings;
}

export function patternFindings(file, text) {
  return [
    ...textFindings(file, text, 'backdoor', BACKDOOR_PATTERNS),
    ...textFindings(file, text, 'no-flake-masking', FLAKE_MASKING_PATTERNS),
    ...(isScenarioFile(file) ? textFindings(file, text, 'scenario-environment', SCENARIO_ENVIRONMENT_PATTERNS) : []),
  ];
}

export function documentedNames(docsText) {
  return new Set(docsText.match(KIMI_NAME) ?? []);
}

export function kimiNameFindings(file, text, documented) {
  const findings = [];
  const seen = new Set();
  for (const found of text.matchAll(KIMI_NAME)) {
    const name = found[0];
    if (seen.has(name)) continue;
    seen.add(name);
    if (documented.has(name)) continue;
    findings.push({
      file,
      line: lineAt(text, found.index),
      rule: 'kimi-names',
      pattern: name,
      match: name,
      instead: `use a variable documented in ${DOCS_FILE}, or register ${name} under testSwitches with a reason`,
    });
  }
  return findings;
}

function tableFinding(match, instead) {
  return { file: TABLE_FILE, rule: TABLE_RULE, pattern: match, match, instead };
}

function hasReason(entry) {
  return typeof entry.reason === 'string' && entry.reason.trim() !== '';
}

function applyExceptions(found, entries, checked) {
  const problems = [];
  let remaining = found;
  for (const entry of entries) {
    const label = `exception ${String(entry.rule)} ${JSON.stringify(entry.pattern)} in ${String(entry.file)}`;
    if (!hasReason(entry)) problems.push(tableFinding(label, 'state why this file needs the pattern in a non-empty reason'));
    if (!EXCEPTABLE_RULES.includes(entry.rule)) {
      problems.push(tableFinding(label, `rule must be one of ${EXCEPTABLE_RULES.join(', ')}; an undocumented KIMI_* name goes under testSwitches`));
      continue;
    }
    if (!checked.has(entry.file)) {
      problems.push(tableFinding(label, `${String(entry.file)} is not a checked file under tests/e2e; fix the path or delete the entry`));
      continue;
    }
    const suppressed = (finding) => finding.file === entry.file && finding.rule === entry.rule && finding.pattern === entry.pattern;
    if (!remaining.some(suppressed)) problems.push(tableFinding(label, 'nothing in that file matches any more, so delete the entry'));
    remaining = remaining.filter((finding) => !suppressed(finding));
  }
  return { remaining, problems };
}

function applyTestSwitches(found, entries, checked) {
  const problems = [];
  let remaining = found;
  for (const entry of entries) {
    const label = `test switch ${String(entry.name)}`;
    if (!hasReason(entry)) problems.push(tableFinding(label, 'state in a non-empty reason why the switch only changes environment-level side effects'));
    if (typeof entry.name !== 'string' || !/^KIMI_[A-Z0-9_]+$/.test(entry.name)) {
      problems.push(tableFinding(label, 'name must be one KIMI_* variable name'));
      continue;
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      problems.push(tableFinding(label, 'list the files under tests/e2e that use the switch in files'));
      continue;
    }
    for (const file of entry.files) {
      if (!checked.has(file)) {
        problems.push(tableFinding(`${label} in ${String(file)}`, `${String(file)} is not a checked file under tests/e2e; fix the path or remove it from files`));
        continue;
      }
      const suppressed = (finding) => finding.file === file && finding.rule === 'kimi-names' && finding.pattern === entry.name;
      if (!remaining.some(suppressed)) {
        problems.push(tableFinding(`${label} in ${file}`, 'that file no longer uses the name, or the name is now documented, so remove it from the table'));
      }
      remaining = remaining.filter((finding) => !suppressed(finding));
    }
  }
  return { remaining, problems };
}

export function checkBoundary(files, table, docsText) {
  const checkedFiles = files.filter(({ file }) => isCheckedFile(file));
  const checked = new Set(checkedFiles.map(({ file }) => file));
  const documented = documentedNames(docsText);
  const found = checkedFiles.flatMap(({ file, text }) => [
    ...importFindings(file, text),
    ...patternFindings(file, text),
    ...kimiNameFindings(file, text, documented),
  ]);
  const excepted = applyExceptions(found, table.exceptions ?? [], checked);
  const switched = applyTestSwitches(excepted.remaining, table.testSwitches ?? [], checked);
  return [...switched.remaining, ...excepted.problems, ...switched.problems];
}

export function formatReport(findings) {
  const lines = [];
  for (const [rule, { title, why, fix }] of Object.entries(RULES)) {
    const matching = findings
      .filter((finding) => finding.rule === rule)
      .toSorted((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
    if (matching.length === 0) continue;
    lines.push(`✗ e2e-boundary: ${title}`);
    for (const finding of matching) {
      const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
      lines.push(`  ${where}  ${finding.match}`, `    instead: ${finding.instead}`);
    }
    lines.push(`  Why: ${why}`, `  What to do: ${fix}`);
  }
  return lines;
}

function checkedSources() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', E2E_ROOT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\0')
    .filter((file) => file !== '' && isCheckedFile(file) && existsSync(join(ROOT, file)))
    .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
}

export function main(args) {
  if (args.length > 0) {
    process.stderr.write(`✗ e2e-boundary: unsupported arguments ${args.join(' ')}. Run \`pnpm lint\` or \`node ${CHECK_FILE}\` without arguments.\n`);
    return 2;
  }
  for (const required of [TABLE_FILE, DOCS_FILE]) {
    if (existsSync(join(ROOT, required))) continue;
    process.stderr.write(`✗ e2e-boundary: ${required} is missing, so the check cannot decide which exceptions and KIMI_* names are allowed. Restore it.\n`);
    return 1;
  }
  const table = JSON.parse(readFileSync(join(ROOT, TABLE_FILE), 'utf8'));
  const files = checkedSources();
  const report = formatReport(checkBoundary(files, table, readFileSync(join(ROOT, DOCS_FILE), 'utf8')));
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  const registered = (table.exceptions ?? []).length + (table.testSwitches ?? []).length;
  process.stdout.write(`✓ e2e-boundary: ${files.length} files under tests/e2e reach the product only through allowlisted imports and user operations (${registered} registered exceptions)\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
