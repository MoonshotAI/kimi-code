import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  BACKDOOR_PATTERNS,
  checkBoundary,
  documentedNames,
  FLAKE_MASKING_PATTERNS,
  formatReport,
  importFindings,
  isCheckedFile,
  kimiNameFindings,
  main,
  moduleReferences,
  patternFindings,
  SCENARIO_ENVIRONMENT_PATTERNS,
} from './e2e-boundary.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCENARIO = 'tests/e2e/scenarios/files/read-and-edit.spec.ts';
const SELF_TEST = 'tests/e2e/self-test/approve.spec.ts';
const SUPPORT = 'tests/e2e/support/scenario.ts';
const TUI = 'tests/e2e/surfaces/tui.ts';
const ACP = 'tests/e2e/surfaces/acp.ts';
const DESKTOP = 'tests/e2e/surfaces/desktop.ts';
const DOCS = 'Set `KIMI_CODE_HOME` to move the data directory. `KIMI_CODE_TRUST_WORKSPACE=1` trusts the workspace.';
const NO_EXCEPTIONS = { exceptions: [], testSwitches: [] };

function byName(a, b) {
  return a.localeCompare(b);
}

function patterns(findings, rule) {
  return findings.filter((finding) => finding.rule === rule).map((finding) => finding.pattern);
}

function importPatterns(file, text) {
  return patterns(importFindings(file, text), 'imports');
}

function textPatterns(file, text, rule) {
  return patterns(patternFindings(file, text), rule);
}

await test('isCheckedFile covers JS and TS sources under tests/e2e and nothing else', () => {
  for (const extension of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'tsx', 'jsx']) {
    assert.equal(isCheckedFile(`tests/e2e/surfaces/driver.${extension}`), true, extension);
  }
  assert.equal(isCheckedFile('tests/e2e/playwright.config.ts'), true);
  assert.equal(isCheckedFile('tests/e2e/AGENTS.md'), false);
  assert.equal(isCheckedFile('tests/e2e/package.json'), false);
  assert.equal(isCheckedFile('tests/e2e/node_modules/pkg/index.js'), false);
  assert.equal(isCheckedFile('tests/scenarios/support/scenario.ts'), false);
  assert.equal(isCheckedFile('apps/desktop/e2e/core-turn.spec.ts'), false);
});

await test('moduleReferences reads every way a file can name a module', () => {
  const { references, dynamic, sleeps, parseErrors } = moduleReferences(
    TUI,
    [
      "import a, { until } from '@moonshot-ai/testkit/fixtures';",
      "import 'side-effect';",
      "export { x } from './x';",
      "export * from './y';",
      "import type { Page } from '@playwright/test';",
      "import fs = require('node:fs');",
      "type Server = typeof import('@moonshot-ai/kap-server');",
      "const lazy = await import('./lazy');",
      'const computed = await import(name);',
      "const required = require('req');",
      'const requiredByName = require(name);',
      "const resolved = import.meta.resolve('tsx');",
      'const text = "this sentence came from \'nowhere\'";',
    ].join('\n'),
  );
  assert.deepEqual(parseErrors, []);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(
    references.map(({ specifier, line }) => `${line}:${specifier}`),
    ['1:@moonshot-ai/testkit/fixtures', '2:side-effect', '3:./x', '4:./y', '5:@playwright/test', '6:node:fs', '7:@moonshot-ai/kap-server', '8:./lazy', '10:req', '12:tsx'],
  );
  assert.deepEqual(dynamic, [
    { call: 'import(', line: 9 },
    { call: 'require(', line: 11 },
  ]);
});

await test('imports: support and driver files may use the testkit, Playwright, the listed builtins and files inside tests/e2e', () => {
  const allowed = [
    "import { expect, test } from '@playwright/test';",
    "import { until } from '@moonshot-ai/testkit/fixtures';",
    "import { say } from '@moonshot-ai/testkit/model';",
    "import { createHash } from 'node:crypto';",
    "import { existsSync } from 'node:fs';",
    "import { readFile } from 'node:fs/promises';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { Writable } from 'node:stream';",
    "import { pathToFileURL } from 'node:url';",
    "import { VERBS } from './verbs';",
    "import { startTui } from '../surfaces/tui.ts';",
    "const selfTest = () => import('../self-test/send.spec.ts');",
  ].join('\n');
  assert.deepEqual(importFindings(SUPPORT, allowed), []);
});

await test('imports: anything outside the allowlist is rejected, including product packages, legacy fixtures and network modules', () => {
  const rejected = [
    '@moonshot-ai/kap-server',
    '@moonshot-ai/klient',
    '@moonshot-ai/agent-core-v2',
    '@moonshot-ai/acp-server',
    '@moonshot-ai/app-core',
    '@moonshot-ai/testkit/kap',
    '@moonshot-ai/testkit/vitest',
    '@moonshot-ai/testkit',
    '@moonshot-ai/a-package-added-next-year',
    'vitest',
    'ws',
    'node:http',
    'node:https',
    'node:net',
    'node:timers/promises',
    'fs',
    'child_process',
    '../../../apps/desktop/e2e/fixtures/app',
    '../../../packages/kap-server/src/start',
    '../../scenarios/support/scenario',
    '../node_modules/ws/index.js',
    '#/utils/process/fd-detect',
    '/absolute/path.ts',
  ];
  const text = rejected.map((specifier, index) => `import x${index} from '${specifier}';`).join('\n');
  assert.deepEqual(importPatterns(SUPPORT, text), rejected);
  const [first] = importFindings(SUPPORT, text);
  assert.deepEqual({ file: first.file, line: first.line, rule: first.rule, match: first.match }, { file: SUPPORT, line: 1, rule: 'imports', match: '@moonshot-ai/kap-server' });
  assert.match(first.instead, /@moonshot-ai\/testkit\/model/);
});

await test('imports: the editor SDK, the virtual terminal and child_process are limited to the drivers that need them', () => {
  const sdk = "import * as acp from '@agentclientprotocol/sdk';";
  const terminal = "import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';";
  const spawn = "import { spawn } from 'node:child_process';";
  assert.deepEqual(importFindings(ACP, [sdk, spawn].join('\n')), []);
  assert.deepEqual(importFindings(TUI, [terminal, spawn].join('\n')), []);
  assert.deepEqual(importPatterns(TUI, sdk), ['@agentclientprotocol/sdk']);
  assert.deepEqual(importPatterns(ACP, terminal), ['@moonshot-ai/pi-tui/testing']);
  assert.deepEqual(importPatterns(DESKTOP, [sdk, terminal, spawn].join('\n')), ['@agentclientprotocol/sdk', '@moonshot-ai/pi-tui/testing', 'node:child_process']);
  assert.match(importFindings(DESKTOP, spawn)[0].instead, /allowed only in tests\/e2e\/surfaces\/tui\.ts and tests\/e2e\/surfaces\/acp\.ts/);
});

await test('imports: scenarios and self-tests see only support/scenario and the testkit script steps', () => {
  const allowed = ["import { edit, read, say } from '@moonshot-ai/testkit/model';", "import { expect, scenario } from '../../support/scenario';"].join('\n');
  assert.deepEqual(importFindings(SCENARIO, allowed), []);
  assert.deepEqual(importFindings(SELF_TEST, "import { expect, scenario } from '../support/scenario.ts';"), []);
  const rejected = [
    '@playwright/test',
    '@moonshot-ai/testkit/fixtures',
    'node:fs',
    '../../support/verbs',
    '../../surfaces/tui',
    '../support/scenario',
  ];
  const text = rejected.map((specifier, index) => `import x${index} from '${specifier}';`).join('\n');
  assert.deepEqual(importPatterns(SCENARIO, text), rejected);
  assert.match(importFindings(SCENARIO, text)[0].instead, /import only tests\/e2e\/support\/scenario\.ts/);
});

await test('imports: a computed import or require is a finding, a literal one is checked like any import', () => {
  assert.deepEqual(importPatterns(SUPPORT, 'const loaded = await import(pathToFileURL(file).href);'), ['import(']);
  assert.deepEqual(importPatterns(SUPPORT, 'const loaded = await import(`../self-test/${name}.spec.ts`);'), ['import(']);
  assert.deepEqual(importPatterns(SUPPORT, 'const loaded = require(name);'), ['require(']);
  assert.deepEqual(importPatterns(SUPPORT, 'const loaded = await import(`./verbs`);'), []);
  assert.deepEqual(importPatterns(SUPPORT, "const loaded = await import('node:net');"), ['node:net']);
  assert.deepEqual(importPatterns(SUPPORT, "const loaded = require('ws');"), ['ws']);
  assert.deepEqual(importPatterns(SUPPORT, "const url = import.meta.resolve('@moonshot-ai/kap-server');"), ['@moonshot-ai/kap-server']);
});

await test('imports: a file that does not parse is reported instead of passing unchecked', () => {
  const findings = importFindings(SUPPORT, 'import { from;');
  assert.equal(findings.length > 0, true);
  assert.deepEqual([...new Set(findings.map(({ rule, pattern }) => `${rule}:${pattern}`))], ['imports:parse error']);
});

await test('backdoor: each pattern is reported with its line and what to do instead', () => {
  const samples = {
    '.evaluate(': 'await page.evaluate(() => 1);',
    '.evaluateHandle(': 'await page.evaluateHandle(() => window);',
    '.$eval(': "await page.$eval('a', (node) => node.id);",
    '.$$eval(': "await page.$$eval('a', (nodes) => nodes.length);",
    '.addInitScript(': 'await context.addInitScript(() => {});',
    '.exposeFunction(': "await page.exposeFunction('probe', () => 1);",
    '.exposeBinding(': "await page.exposeBinding('probe', () => 1);",
    '.route(': "await page.route('**/*', (route) => route.abort());",
    '.routeFromHAR(': "await page.routeFromHAR('trace.har');",
    APIRequestContext: 'let api: APIRequestContext;',
    '.request.': "await page.request.get('/health');",
    'request.newContext': 'const api = await request.newContext();',
    '.setExtraHTTPHeaders(': 'await page.setExtraHTTPHeaders({});',
    '.addCookies(': 'await context.addCookies([]);',
    storageState: 'const state = { storageState: path };',
    '.dispatchEvent(': "await locator.dispatchEvent('click');",
    'fetch(': 'const response = await fetch(url);',
    WebSocket: 'const socket = new WebSocket(url);',
    '/api/v1': "const sessions = `${origin}/api/v1/sessions`;",
    '/openapi.json': "const spec = `${origin}/openapi.json`;",
    '/asyncapi.json': "const spec = `${origin}/asyncapi.json`;",
    Authorization: 'const headers = { Authorization: token };',
    'Bearer ': 'const header = `Bearer ${token}`;',
    'kimi-code.bearer.': "const protocol = 'kimi-code.bearer.' + token;",
    'server.token': "const token = join(home, 'server.token');",
    '--debug-endpoints': "const args = ['web', '--debug-endpoints'];",
    '--dangerous-bypass-auth': "const args = ['web', '--dangerous-bypass-auth'];",
    '--socket': "const args = ['web', '--socket', path];",
    '--allow-remote-shutdown': "const args = ['web', '--allow-remote-shutdown'];",
    kimi_onboarded: 'const url = `${origin}/?kimi_onboarded=1`;',
    kimi_desktop: 'const url = `${origin}/?kimi_desktop=1`;',
    kimi_origin: 'const url = `${origin}/?kimi_origin=x`;',
    kimi_embedded: 'const url = `${origin}/?kimi_embedded=1`;',
    kimi_native_titlebar: 'const url = `${origin}/?kimi_native_titlebar=1`;',
    __kimiApi: 'const api = window.__kimiApi;',
    kimiDesktop: 'const bridge = window.kimiDesktop;',
    localStorage: "const token = localStorage.getItem('token');",
    sessionStorage: 'sessionStorage.clear();',
  };
  for (const [label, line] of Object.entries(samples)) {
    const findings = patternFindings(DESKTOP, ['const before = 1;', line].join('\n')).filter((finding) => finding.pattern === label);
    assert.equal(findings.length, 1, label);
    assert.deepEqual({ file: findings[0].file, line: findings[0].line, rule: findings[0].rule }, { file: DESKTOP, line: 2, rule: 'backdoor' }, label);
    assert.equal(findings[0].instead.length > 0, true, label);
  }
  assert.deepEqual(textPatterns(DESKTOP, "await page.routeWebSocket('**', () => {});", 'backdoor').toSorted(byName), ['.routeWebSocket(', 'WebSocket']);
  assert.deepEqual(textPatterns(DESKTOP, "const env = { KIMI_CODE_DISABLE_HOST_CHECK: '1', KIMI_CODE_CORS_ORIGINS: '*' };", 'backdoor'), ['KIMI_CODE_DISABLE_HOST_CHECK', 'KIMI_CODE_CORS_ORIGINS']);
  const covered = new Set([...Object.keys(samples), '.routeWebSocket(', 'KIMI_CODE_DISABLE_HOST_CHECK', 'KIMI_CODE_CORS_ORIGINS']);
  assert.deepEqual(BACKDOOR_PATTERNS.map(({ label }) => label).filter((label) => !covered.has(label)), []);
});

await test('backdoor: user operations and the fake model request log are not mistaken for backdoors', () => {
  const allowed = [
    "const afterRead = model.requests('main')[1];",
    'const requests = model.requests();',
    "await page.getByRole('button', { name: 'Approve', exact: true }).click();",
    'await page.keyboard.type(text);',
    'await page.goto(url);',
    "context.on('request', (request) => seen.push(request.url()));",
    "context.on('websocket', (socket) => seen.push(socket.url()));",
    'const fetchStubs = [...kimiServiceStubs()];',
    'await prefetch(url);',
    "await product.send('Then fetch the latest file.');",
    "const args = ['web', '--port', '0', '--no-open', '--socket-timeout'];",
    "const env = { KIMI_DESKTOP_E2E: 'quiet' };",
    "const launch = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'];",
    "const stopped = page.getByRole('status').filter({ hasText: 'Manually stopped' });",
  ].join('\n');
  assert.deepEqual(textPatterns(DESKTOP, allowed, 'backdoor'), []);
});

await test('backdoor: fetch is reported however it is reached', () => {
  for (const text of ['const response = await fetch (url);', 'const request = globalThis.fetch;', 'await globalThis.fetch(url);']) {
    assert.deepEqual(textPatterns(DESKTOP, text, 'backdoor'), ['fetch('], text);
  }
});

await test('no-flake-masking: skipping, retrying and fixed waits are reported', () => {
  const samples = {
    '.skip(': "test.skip('later', async () => {});",
    '.fixme(': "test.fixme('broken', async () => {});",
    '.fail(': "test.fail('known', async () => {});",
    '.only(': "test.only('mine', async () => {});",
    'waitForTimeout(': 'await page.waitForTimeout(500);',
    'setTimeout(': 'await new Promise((done) => setTimeout(done, 100));',
    'setInterval(': 'const timer = setInterval(poll, 100);',
    'sleep(': 'await fixtures.sleep(100);',
    'Atomics.wait': 'Atomics.wait(view, 0, 0, 100);',
    'toPass(': 'await expect(async () => check()).toPass();',
  };
  for (const [label, line] of Object.entries(samples)) {
    const findings = patternFindings(TUI, ['const before = 1;', line].join('\n')).filter((finding) => finding.pattern === label);
    assert.equal(findings.length, 1, label);
    assert.deepEqual({ line: findings[0].line, rule: findings[0].rule }, { line: 2, rule: 'no-flake-masking' }, label);
  }
  const covered = new Set([...Object.keys(samples), 'retries']);
  assert.deepEqual(FLAKE_MASKING_PATTERNS.map(({ label }) => label).filter((label) => !covered.has(label)), []);
});

await test('no-flake-masking: retries is allowed only as exactly `retries: 0`', () => {
  assert.deepEqual(textPatterns('tests/e2e/playwright.config.ts', 'export default defineConfig({ retries: 0, forbidOnly: true });', 'no-flake-masking'), []);
  assert.deepEqual(textPatterns('tests/e2e/playwright.config.ts', 'export default defineConfig({ retries:0 });', 'no-flake-masking'), []);
  for (const text of [
    'export default defineConfig({ retries: 1 });',
    'export default defineConfig({ retries: 0.5 });',
    'export default defineConfig({ retries: 10 });',
    "export default defineConfig({ retries: process.env['CI'] ? 2 : 0 });",
    'test.describe.configure({ retries: 2 });',
    'export default defineConfig({ retries });',
    'export default defineConfig({ retries, forbidOnly: true });',
    'config.retries = 2;',
  ]) {
    assert.deepEqual(textPatterns('tests/e2e/playwright.config.ts', text, 'no-flake-masking'), ['retries'], text);
  }
});

await test('no-flake-masking: importing sleep from the testkit fixtures is reported, condition waits are not', () => {
  const sleepRule = (file, text) => importFindings(file, text).filter((finding) => finding.rule === 'no-flake-masking');
  assert.deepEqual(sleepRule(TUI, "import { sleep, until } from '@moonshot-ai/testkit/fixtures';").map(({ pattern, line }) => `${pattern}:${line}`), ['sleep:1']);
  assert.deepEqual(sleepRule(TUI, "import {\n  until,\n  sleep as pause,\n} from '@moonshot-ai/testkit/fixtures';").map(({ pattern, line }) => `${pattern}:${line}`), ['sleep:3']);
  assert.deepEqual(sleepRule(TUI, "export { sleep } from '@moonshot-ai/testkit/fixtures';").map(({ pattern }) => pattern), ['sleep']);
  assert.deepEqual(sleepRule(TUI, "import { TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';"), []);
  assert.deepEqual(sleepRule(TUI, "import { sleep } from './local';"), []);
  const allowed = [
    "await until('the approval panel', () => screen.includes('confirm'));",
    'await expect.poll(() => count()).toBe(1);',
    "model.script(after(50, say('later')), paced(say('slow'), 10));",
    'const retried = false;',
    "scenario('retries a failed provider step', {}, run);",
    'const attempts = config.retries;',
    "const failed = status === 'failed';",
  ].join('\n');
  assert.deepEqual(textPatterns(TUI, allowed, 'no-flake-masking'), []);
});

await test('scenario-environment: scenarios and self-tests cannot read the process, the test info or the surface', () => {
  const text = ["const surface = process.env['SURFACE'];", 'const project = test.info().project.name;', 'const attach = (testInfo) => testInfo.attach;'].join('\n');
  assert.deepEqual(textPatterns(SCENARIO, text, 'scenario-environment'), ['process.', 'test.info(', 'testInfo', 'testInfo']);
  assert.deepEqual(textPatterns(SELF_TEST, text, 'scenario-environment'), ['process.', 'test.info(', 'testInfo', 'testInfo']);
  assert.deepEqual(patternFindings(SCENARIO, text).find((finding) => finding.pattern === 'test.info(').line, 2);
  assert.deepEqual(SCENARIO_ENVIRONMENT_PATTERNS.map(({ label }) => label), ['process.', 'test.info(', 'testInfo']);
  assert.deepEqual(textPatterns(SCENARIO, "const surface = process['env'].SURFACE;", 'scenario-environment'), ['process.']);
  assert.deepEqual(textPatterns(SCENARIO, "await product.send('Stop the background process.');", 'scenario-environment'), []);
  assert.deepEqual(textPatterns(SCENARIO, "await product.send('Kill the process. Then report back.');", 'scenario-environment'), []);
});

await test('scenario-environment: support and drivers may use the process and the test info, and a plain scenario is clean', () => {
  const text = ["const headed = process.env['E2E_HEADED'] === '1';", 'await testInfo.attach(name, { body });'].join('\n');
  assert.deepEqual(textPatterns(SUPPORT, text, 'scenario-environment'), []);
  assert.deepEqual(textPatterns(TUI, text, 'scenario-environment'), []);
  const scenario = [
    "scenario('reads one file and edits another after approval', { workspace: { 'a.txt': 'hello\\n' } }, async ({ product, model, workspace }) => {",
    "  model.script(read('a.txt'), say('Done.'));",
    "  await product.send('Read a.txt.');",
    '  await product.waitIdle();',
    "  await product.expectReply('Done.');",
    "  await workspace.expectFile('a.txt', 'hello\\n');",
    '});',
  ].join('\n');
  assert.deepEqual(patternFindings(SCENARIO, scenario), []);
});

await test('kimi-names: a KIMI_* name must be documented for users, and each undocumented name is reported once per file', () => {
  const documented = documentedNames(DOCS);
  assert.deepEqual([...documented].toSorted(byName), ['KIMI_CODE_HOME', 'KIMI_CODE_TRUST_WORKSPACE']);
  const text = [
    "const env = { KIMI_CODE_HOME: home, KIMI_CODE_TRUST_WORKSPACE: '1' };",
    "const quiet = { KIMI_DESKTOP_E2E: 'quiet', KIMI_DESKTOP_NO_SHELL_ENV: '1' };",
    "const again = { KIMI_DESKTOP_E2E: '1', KIMI_CODE: 'prefix of a documented name' };",
  ].join('\n');
  const findings = kimiNameFindings(DESKTOP, text, documented);
  assert.deepEqual(findings.map(({ pattern, line, rule }) => `${rule}:${pattern}:${line}`), ['kimi-names:KIMI_DESKTOP_E2E:2', 'kimi-names:KIMI_DESKTOP_NO_SHELL_ENV:2', 'kimi-names:KIMI_CODE:3']);
  assert.match(findings[0].instead, /testSwitches/);
  assert.deepEqual(kimiNameFindings(DESKTOP, "const env = { KIMI_CODE_HOME: home, KIMI_CODE_TRUST_WORKSPACE: '1' };", documented), []);
});

await test('checkBoundary reports every rule for files under tests/e2e and ignores files elsewhere', () => {
  const files = [
    { file: SCENARIO, text: "import { test } from '@playwright/test';\nconst surface = process.env['SURFACE'];" },
    { file: DESKTOP, text: "await page.evaluate(() => 1);\nawait page.waitForTimeout(10);\nconst env = { KIMI_DESKTOP_E2E: 'quiet' };" },
    { file: 'apps/desktop/e2e/core-turn.spec.ts', text: "await page.evaluate(() => 1);\ntest.skip('x', () => {});" },
  ];
  const findings = checkBoundary(files, NO_EXCEPTIONS, DOCS);
  assert.deepEqual(
    findings.map(({ file, line, rule, pattern }) => `${file}:${line} ${rule} ${pattern}`).toSorted(byName),
    [
      `${DESKTOP}:1 backdoor .evaluate(`,
      `${DESKTOP}:2 no-flake-masking waitForTimeout(`,
      `${DESKTOP}:3 kimi-names KIMI_DESKTOP_E2E`,
      `${SCENARIO}:1 imports @playwright/test`,
      `${SCENARIO}:2 scenario-environment process.`,
    ].toSorted(byName),
  );
  const clean = [{ file: SUPPORT, text: "import { test } from '@playwright/test';\nexport const scenario = test;" }];
  assert.deepEqual(checkBoundary(clean, NO_EXCEPTIONS, DOCS), []);
});

await test('exceptions: a registered exception suppresses exactly its file, rule and pattern', () => {
  const files = [
    { file: SUPPORT, text: 'testInfo.skip(true, reason);\ntest.only(title, body);' },
    { file: TUI, text: 'testInfo.skip(true, reason);' },
  ];
  const table = { exceptions: [{ file: SUPPORT, rule: 'no-flake-masking', pattern: '.skip(', reason: 'reports a surface declared as not applicable' }], testSwitches: [] };
  assert.deepEqual(
    checkBoundary(files, table, DOCS).map(({ file, line, pattern }) => `${file}:${line} ${pattern}`),
    [`${SUPPORT}:2 .only(`, `${TUI}:1 .skip(`],
  );
});

await test('exceptions: an entry needs a reason, a known rule, a checked file, and must still suppress something', () => {
  const files = [{ file: SUPPORT, text: 'testInfo.skip(true, reason);' }];
  const problems = (exception) => checkBoundary(files, { exceptions: [exception], testSwitches: [] }, DOCS);
  const valid = { file: SUPPORT, rule: 'no-flake-masking', pattern: '.skip(', reason: 'reports a surface declared as not applicable' };
  assert.deepEqual(problems(valid), []);

  for (const reason of ['', '   ', undefined]) {
    const noReason = problems({ ...valid, reason });
    assert.deepEqual(noReason.map(({ rule, file }) => `${rule}:${file}`), ['exceptions:scripts/checks/e2e-boundary.json']);
    assert.match(noReason[0].instead, /non-empty reason/);
  }

  const missingFile = problems({ ...valid, file: 'tests/e2e/support/gone.ts' });
  assert.deepEqual(missingFile.map(({ rule }) => rule).toSorted(byName), ['exceptions', 'no-flake-masking']);
  assert.match(missingFile.find(({ rule }) => rule === 'exceptions').instead, /not a checked file under tests\/e2e/);

  const outside = problems({ ...valid, file: 'apps/desktop/e2e/core-turn.spec.ts' });
  assert.match(outside.find(({ rule }) => rule === 'exceptions').instead, /not a checked file under tests\/e2e/);

  const stale = checkBoundary([{ file: SUPPORT, text: 'export const scenario = 1;' }], { exceptions: [valid], testSwitches: [] }, DOCS);
  assert.deepEqual(stale.map(({ rule }) => rule), ['exceptions']);
  assert.match(stale[0].instead, /delete the entry/);

  const wrongRule = problems({ ...valid, rule: 'kimi-names' });
  assert.deepEqual(wrongRule.map(({ rule }) => rule).toSorted(byName), ['exceptions', 'no-flake-masking']);
  assert.match(wrongRule.find(({ rule }) => rule === 'exceptions').instead, /testSwitches/);
});

await test('testSwitches: a registered switch allows an undocumented KIMI_* name only in the listed files', () => {
  const files = [
    { file: DESKTOP, text: "const env = { KIMI_DESKTOP_E2E: 'quiet' };" },
    { file: TUI, text: "const env = { KIMI_DESKTOP_E2E: 'quiet' };" },
  ];
  const table = { exceptions: [], testSwitches: [{ name: 'KIMI_DESKTOP_E2E', files: [DESKTOP], reason: 'only hides DevTools, the tray and the quit prompt' }] };
  assert.deepEqual(
    checkBoundary(files, table, DOCS).map(({ file, rule, pattern }) => `${file} ${rule} ${pattern}`),
    [`${TUI} kimi-names KIMI_DESKTOP_E2E`],
  );
});

await test('testSwitches: an entry needs a reason, a KIMI_* name, checked files, and must still be needed', () => {
  const files = [
    { file: DESKTOP, text: "const env = { KIMI_DESKTOP_E2E: 'quiet', KIMI_CODE_HOME: home };" },
    { file: TUI, text: 'const env = { KIMI_CODE_HOME: home };' },
  ];
  const problems = (entry) => checkBoundary(files, { exceptions: [], testSwitches: [entry] }, DOCS);
  const valid = { name: 'KIMI_DESKTOP_E2E', files: [DESKTOP], reason: 'only hides DevTools, the tray and the quit prompt' };
  assert.deepEqual(problems(valid), []);

  const noReason = problems({ ...valid, reason: ' ' });
  assert.deepEqual(noReason.map(({ rule }) => rule), ['exceptions']);
  assert.match(noReason[0].instead, /non-empty reason/);

  assert.match(problems({ ...valid, name: 'DESKTOP_E2E' }).find(({ rule }) => rule === 'exceptions').instead, /KIMI_\* variable name/);
  assert.match(problems({ ...valid, files: [] }).find(({ rule }) => rule === 'exceptions').instead, /list the files/);
  assert.match(problems({ ...valid, files: ['tests/e2e/surfaces/gone.ts'] }).find(({ rule }) => rule === 'exceptions').instead, /not a checked file/);

  const unused = problems({ ...valid, files: [DESKTOP, TUI] });
  assert.deepEqual(unused.map(({ rule, pattern }) => `${rule}:${pattern}`), ['exceptions:test switch KIMI_DESKTOP_E2E in tests/e2e/surfaces/tui.ts']);
  assert.match(unused[0].instead, /no longer uses the name/);

  const documented = problems({ name: 'KIMI_CODE_HOME', files: [DESKTOP], reason: 'already public' });
  assert.deepEqual(documented.map(({ rule, pattern }) => `${rule}:${pattern}`).toSorted(byName), ['exceptions:test switch KIMI_CODE_HOME in tests/e2e/surfaces/desktop.ts', 'kimi-names:KIMI_DESKTOP_E2E']);
});

await test('formatReport groups findings by rule and says why the rule exists and what to do', () => {
  const files = [
    { file: SCENARIO, text: "import { test } from '@playwright/test';\nconst surface = process.env['SURFACE'];" },
    { file: DESKTOP, text: "await page.evaluate(() => 1);\nawait page.waitForTimeout(10);\nconst env = { KIMI_DESKTOP_E2E: 'quiet' };" },
  ];
  const stale = { file: SUPPORT, rule: 'backdoor', pattern: '.route(', reason: 'left over' };
  const report = formatReport(checkBoundary([...files, { file: SUPPORT, text: 'export const scenario = 1;' }], { exceptions: [stale], testSwitches: [] }, DOCS)).join('\n');
  assert.match(report, /✗ e2e-boundary: tests\/e2e imports a module outside its allowlist\n {2}tests\/e2e\/scenarios\/files\/read-and-edit\.spec\.ts:1 {2}@playwright\/test\n {4}instead: scenarios and self-tests import only/);
  assert.match(report, /✗ e2e-boundary: tests\/e2e uses an entry point a user cannot reach\n {2}tests\/e2e\/surfaces\/desktop\.ts:1 {2}\.evaluate\(/);
  assert.match(report, /✗ e2e-boundary: tests\/e2e skips, retries or waits a fixed time\n {2}tests\/e2e\/surfaces\/desktop\.ts:2 {2}waitForTimeout\(/);
  assert.match(report, /✗ e2e-boundary: a scenario or self-test reads its environment\n {2}tests\/e2e\/scenarios\/files\/read-and-edit\.spec\.ts:2 {2}process\./);
  assert.match(report, /✗ e2e-boundary: tests\/e2e uses a KIMI_\* name that is not documented for users\n {2}tests\/e2e\/surfaces\/desktop\.ts:3 {2}KIMI_DESKTOP_E2E/);
  assert.match(report, /✗ e2e-boundary: scripts\/checks\/e2e-boundary\.json has an invalid or stale entry\n {2}scripts\/checks\/e2e-boundary\.json {2}exception backdoor "\.route\(" in tests\/e2e\/support\/scenario\.ts/);
  assert.equal(report.match(/^ {2}Why: /gm).length, 6);
  assert.equal(report.match(/^ {2}What to do: /gm).length, 6);
  assert.match(report, /Why: Drivers must not cover for the product\./);
  assert.match(report, /Why: This masks flakiness\./);
  assert.match(report, /Why: This weakens the shared UI assertions\./);
  assert.match(report, /scripts\/checks\/e2e-boundary\.json with a reason and reviewed by CODEOWNERS/);
  assert.deepEqual(formatReport([]), []);
});

await test('the committed exception table is well formed and main rejects arguments', (context) => {
  const table = JSON.parse(readFileSync(join(ROOT, 'scripts/checks/e2e-boundary.json'), 'utf8'));
  assert.deepEqual(Object.keys(table).toSorted(byName), ['exceptions', 'testSwitches']);
  for (const entry of table.exceptions) {
    assert.deepEqual(Object.keys(entry).toSorted(byName), ['file', 'pattern', 'reason', 'rule']);
    assert.equal(entry.reason.trim().length > 0, true);
  }
  for (const entry of table.testSwitches) {
    assert.deepEqual(Object.keys(entry).toSorted(byName), ['files', 'name', 'reason']);
    assert.equal(entry.reason.trim().length > 0, true);
  }
  let printed = '';
  context.mock.method(process.stderr, 'write', (chunk) => {
    printed += chunk;
    return true;
  });
  assert.equal(main(['--update']), 2);
  context.mock.restoreAll();
  assert.match(printed, /unsupported arguments --update/);
});
