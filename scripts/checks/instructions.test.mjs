import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAllowlist,
  checkBudgets,
  entriesOf,
  invalidEntries,
  referencesIn,
  resolveReference,
} from './instructions.mjs';

await test('referencesIn collects links and path-like code spans outside code fences', () => {
  const text = [
    'Read [the guide](docs/guide.md#setup) and `packages/core/src/index.ts`.',
    '```',
    '[skipped](nowhere.md) `apps/skipped/file.ts`',
    '```',
    'Ignore [a site](https://example.com), `@moonshot-ai/klient/ipc`, `#/remote/protocol`, `/api/v1`, `packages/*`, `<dir>/tsconfig.json`, `pnpm exec tsc`, `index.ts`.',
    'Trailing slashes go: `scripts/checks/`.',
  ].join('\n');
  assert.deepEqual(referencesIn(text), [
    { line: 1, kind: 'link', value: 'docs/guide.md' },
    { line: 1, kind: 'path', value: 'packages/core/src/index.ts' },
    { line: 6, kind: 'path', value: 'scripts/checks' },
  ]);
});

await test('referencesIn pairs fences by character and length and accepts CRLF', () => {
  const text = [
    '~~~ts',
    '```',
    '`apps/inside/tilde.ts`',
    '~~~',
    '````md',
    '```',
    '`apps/inside/nested.ts`',
    '```',
    '````',
    '`apps/after/fences.ts`',
  ].join('\r\n');
  assert.deepEqual(referencesIn(text), [{ line: 10, kind: 'path', value: 'apps/after/fences.ts' }]);
});

await test('referencesIn reads link targets the way Markdown does', () => {
  const text = [
    '[titled](docs/a.md "A title") [angled](<docs/with space.md>) [query](docs/b.md?raw=1) [encoded](docs/%E4%B8%AD.md)',
    'A code span is not a link: `h[t](event)` and `[x](nowhere.md)`.',
  ].join('\n');
  assert.deepEqual(referencesIn(text), [
    { line: 1, kind: 'link', value: 'docs/a.md' },
    { line: 1, kind: 'link', value: 'docs/with space.md' },
    { line: 1, kind: 'link', value: 'docs/b.md' },
    { line: 1, kind: 'link', value: 'docs/中.md' },
  ]);
});

await test('referencesIn drops line and anchor suffixes from code paths', () => {
  assert.deepEqual(referencesIn('See `src/a.ts:42`, `src/b.ts:3-9` and `src/c.ts#L7`.'), [
    { line: 1, kind: 'path', value: 'src/a.ts' },
    { line: 1, kind: 'path', value: 'src/b.ts' },
    { line: 1, kind: 'path', value: 'src/c.ts' },
  ]);
});

const entries = entriesOf([
  'docs/guide.md',
  'packages/engine/docs/llm.md',
  'packages/engine/src/llm/AGENTS.md',
]);
const exists = (path) => entries.has(path);

await test('entriesOf lists every listed file and each of its ancestor directories', () => {
  assert.deepEqual(
    [...entries].toSorted(),
    [
      '.',
      'docs',
      'docs/guide.md',
      'packages',
      'packages/engine',
      'packages/engine/docs',
      'packages/engine/docs/llm.md',
      'packages/engine/src',
      'packages/engine/src/llm',
      'packages/engine/src/llm/AGENTS.md',
    ],
  );
});

await test('resolveReference resolves links against the file directory', () => {
  assert.equal(resolveReference('AGENTS.md', { kind: 'link', value: 'docs/guide.md' }, exists), 'found');
  assert.equal(resolveReference('docs/AGENTS.md', { kind: 'link', value: './guide.md' }, exists), 'found');
  assert.equal(resolveReference('docs/AGENTS.md', { kind: 'link', value: './missing.md' }, exists), 'missing');
});

await test('resolveReference resolves paths against any ancestor directory where their first segment exists', () => {
  const nested = 'packages/engine/src/llm/AGENTS.md';
  assert.equal(resolveReference(nested, { kind: 'path', value: 'docs/llm.md' }, exists), 'found');
  assert.equal(resolveReference(nested, { kind: 'path', value: 'docs/gone.md' }, exists), 'missing');
  assert.equal(resolveReference('AGENTS.md', { kind: 'path', value: 'unicorn/no-unnecessary-await' }, exists), 'skipped');
  assert.equal(resolveReference('AGENTS.md', { kind: 'path', value: 'packages/tui' }, exists), 'missing');
});

await test('applyAllowlist explains listed references and reports entries that match nothing', () => {
  const missing = [
    { file: 'AGENTS.md', line: 3, kind: 'path', value: 'packages/tui' },
    { file: 'docs/AGENTS.md', line: 9, kind: 'link', value: './gone.md' },
  ];
  const listed = { file: 'AGENTS.md', reference: 'packages/tui', why: 'upstream path' };
  const stale = { file: 'AGENTS.md', reference: 'apps/web', why: 'other repository' };
  assert.deepEqual(applyAllowlist(missing, [listed, stale]), { unexplained: [missing[1]], unused: [stale] });
});

await test('invalidEntries rejects unresolved entries without a file, a reference or a reason', () => {
  const good = { file: 'AGENTS.md', reference: 'packages/tui', why: 'upstream path' };
  const blank = { file: 'AGENTS.md', reference: 'apps/web', why: ' ' };
  const partial = { file: 'AGENTS.md', why: 'no reference' };
  assert.deepEqual(invalidEntries([good, blank, partial, null]), [blank, partial, null]);
});

await test('checkBudgets reports files over their budget and budgets for missing files', () => {
  const sizes = { 'AGENTS.md': 120, 'docs/AGENTS.md': 80 };
  const result = checkBudgets({ 'AGENTS.md': 100, 'docs/AGENTS.md': 100, 'gone/AGENTS.md': 10 }, (file) => sizes[file]);
  assert.deepEqual(result, [
    { file: 'AGENTS.md', limit: 100, size: 120 },
    { file: 'gone/AGENTS.md', limit: 10, size: undefined },
  ]);
});
