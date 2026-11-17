import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findComments, stripComments } from './check-comments.mjs';

const script = fileURLToPath(new URL('./check-comments.mjs', import.meta.url));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-comments-'));
  dirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

function run(dir, args = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
}

function strip(file, source) {
  return stripComments(file, source, findComments(file, source).comments);
}

await test('finds real comments and ignores comment-like text', () => {
  const source = [
    'const url = "https://example.com/*x*/";',
    'const re = /\\/\\/ not/;',
    'const t = `// no ${a /* yes */}`;',
    '// line',
    '/** doc */',
    'const v = <div>{/* jsx */}// text</div>;',
    '',
  ].join('\n');
  const values = findComments('a.tsx', source).comments.map((comment) => comment.value.trim());
  assert.deepEqual(values, ['yes', 'line', '* doc', 'jsx']);
});

await test('exempts the shebang, tool directives, and their trailing text', () => {
  const source = [
    '#!/usr/bin/env node',
    '/// <reference types="vite/client" />',
    '// @ts-expect-error upstream types are wrong',
    '// oxlint-disable-next-line no-console -- reason',
    '/* eslint-disable */',
    '// prettier-ignore',
    'const a = /* @__PURE__ */ f();',
    'const b = /*#__PURE__*/ f();',
    'import(/* @vite-ignore */ path);',
    '/* c8 ignore next */',
    '/** @vitest-environment jsdom */',
    '/** @jsxImportSource preact */',
    '// a note',
    '',
  ].join('\n');
  const values = findComments('a.ts', source).comments.map((comment) => comment.value);
  assert.deepEqual(values, [' a note']);
});

await test('exempts JSDoc type casts only in JS files', () => {
  const source = 'const a = /** @type {const} */ ("x");\n/** @type {string[]} */\nconst b = [];\n/** @type {string} the name */\nconst c = "";\n';
  assert.deepEqual(
    findComments('a.mjs', source).comments.map((comment) => comment.value),
    ['* @type {string} the name '],
  );
  assert.equal(findComments('a.ts', source).comments.length, 3);
});

await test('removes comments without leaving layout debris', () => {
  const cases = [
    ['// head\n\nconst a = 1;\n', 'const a = 1;\n'],
    ['#!/usr/bin/env node\n// head\n\nrun();\n', '#!/usr/bin/env node\nrun();\n'],
    ['const a = 1; // tail\n', 'const a = 1;\n'],
    ['foo(/* x */ a, b /* y */);\n', 'foo(a, b);\n'],
    ['a();\n\n// gap\n\nb();\n', 'a();\n\nb();\n'],
    ['try {\n  a();\n} catch {\n  // ignore\n}\n', 'try {\n  a();\n} catch {}\n'],
    ['try {\n  a();\n} catch { /* ignore */ }\n', 'try {\n  a();\n} catch {}\n'],
    ['function f() {\n  // lead\n\n  return 1;\n}\n', 'function f() {\n  return 1;\n}\n'],
    ['function f() {\n  a();\n\n  // trail\n}\n', 'function f() {\n  a();\n}\n'],
    ['/**\n * Doc.\n */\nexport const a = 1;\n', 'export const a = 1;\n'],
    ['const x = a/**/+/**/+b;\n', 'const x = a + +b;\n'],
    ['run();\n\n// end\n', 'run();\n'],
  ];
  for (const [source, expected] of cases) assert.equal(strip('a.ts', source), expected);
});

await test('removes JSX comment containers', () => {
  const source = 'const v = (\n  <div>\n    hello\n    {/* note */}\n    <span>a</span>\n  </div>\n);\n';
  assert.equal(strip('a.tsx', source), 'const v = (\n  <div>\n    hello\n    <span>a</span>\n  </div>\n);\n');
});

await test('refuses JSX comment removals that change the text children', () => {
  assert.equal(strip('a.tsx', 'const v = <span>a\n  {/* x */}\n  b</span>;\n'), undefined);
  assert.equal(strip('a.tsx', 'const v = <span>a {/* x */} b</span>;\n'), undefined);
});

await test('keeps automatic semicolon insertion intact', () => {
  const fixed = strip('a.ts', 'function f() {\n  return /*\n */ 1;\n}\n');
  assert.match(fixed, /return\s*\n\s*1;/);
});

await test('refuses a removal that would change the program', () => {
  const source = 'const a = 1;\n';
  assert.equal(stripComments('a.ts', source, [{ type: 'Block', value: '', start: 0, end: 6 }]), undefined);
});

await test('reports comments outside .commentignore and stale entries', () => {
  const dir = repo({
    '.commentignore': '# exempt\nvendor/\ngone/\n',
    'src/a.ts': 'export const a = 1; // note\n',
    'src/clean.ts': 'export const b = 2;\n',
    'vendor/b.ts': '// kept\nexport const c = 3;\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^src\/a\.ts:1:21: \/\/ note$/m);
  assert.doesNotMatch(result.stderr, /vendor\/b\.ts/);
  assert.match(result.stderr, /^\.commentignore:3: "gone\/" matches no file with comments; delete this entry$/m);
  assert.match(result.stderr, /Comments are not allowed/);
});

await test('checks only the given files unless .commentignore is among them', () => {
  const dir = repo({
    '.commentignore': 'vendor/\n',
    'src/a.ts': '// note\nexport const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'vendor/c.ts': '// kept\nexport const c = 3;\n',
  });
  assert.equal(run(dir, ['src/b.ts', 'vendor/c.ts', 'README.md']).status, 0);
  assert.equal(run(dir, [join(dir, 'src/a.ts')]).status, 1);
  assert.equal(run(dir, ['.commentignore']).status, 1);
});

await test('fails on files it cannot parse', () => {
  const dir = repo({ 'src/a.ts': 'const a = ;\n// hidden\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^src\/a\.ts: cannot be parsed/m);
});

await test('--fix deletes reported comments', () => {
  const dir = repo({ 'src/a.ts': '// note\nexport const a = 1; // tail\n' });
  const result = run(dir, ['--fix']);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.match(result.stdout, /removed 2 comment\(s\)/);
});
