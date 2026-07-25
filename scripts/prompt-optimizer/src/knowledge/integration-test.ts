/**
 * Integration test: TS adapter → Rust binary
 *
 * Verifies the full chain: adapter.ts spawns kimi-knowledge binary,
 * passes correct args, and parses the JSON output.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';

const BINARY = resolve(import.meta.dirname, '../../knowledge-rs/target/release/kimi-knowledge.exe');
const TEST_DB = resolve(import.meta.dirname, '../../knowledge-rs/integration-test.db');
const STANDARDS = resolve(import.meta.dirname, '../../knowledge-rs/standards.md');

// Cleanup before test
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

function run(args: string[]): string {
  return execFileSync(BINARY, ['--db', TEST_DB, ...args], { encoding: 'utf-8' });
}

function runJson(args: string[]): unknown {
  const output = run(['--json', ...args]);
  return JSON.parse(output);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
}

console.log('=== Integration Test: TS adapter → Rust binary ===\n');

// Test 1: Binary exists
console.log('1. Binary exists');
assert(existsSync(BINARY), `Binary at ${BINARY}`);

// Test 2: Import
console.log('\n2. Import standards.md');
const importOutput = run(['import', STANDARDS]);
assert(importOutput.includes('Imported 25 entries'), `Imported 25 entries`);

// Test 3: Stats (JSON)
console.log('\n3. Stats (JSON parse)');
const stats = runJson(['stats']) as { total: number; by_category: Record<string, number> };
assert(stats.total === 25, `total = ${stats.total} (expected 25)`);
assert(stats.by_category['coding-style'] === 6, `coding-style = ${stats.by_category['coding-style']}`);
assert(stats.by_category['workflow'] === 12, `workflow = ${stats.by_category['workflow']}`);

// Test 4: Search (JSON)
console.log('\n4. Search "import" (JSON parse)');
const searchResults = runJson(['search', 'import']) as Array<{ entry: { title: string }; relevance: number }>;
assert(searchResults.length > 0, `Got ${searchResults.length} results`);
assert(searchResults[0]!.entry.title.includes('Import'), `First result: "${searchResults[0]!.entry.title}"`);
assert(typeof searchResults[0]!.relevance === 'number', `relevance is number: ${searchResults[0]!.relevance}`);

// Test 5: Search with --scope (JSON) — scope match returns entries whose scope is a prefix of the path, OR global (null scope)
console.log('\n5. Search with scope');
const scopeResults = runJson(['search', 'changeset', '--scope', 'apps/kimi-code/src/file.ts']) as Array<{ entry: { scope: string | null; title: string }; match_source: string[] }>;
const scopeMatched = scopeResults.filter(r => r.match_source.includes('scope'));
assert(scopeMatched.length > 0, `Scope-matched entries: ${scopeMatched.length}`);

// Test 6: Search with --tags (JSON)
console.log('\n6. Search with tags');
const tagResults = runJson(['search', 'code', '--tags', 'typescript,import']) as Array<{ entry: { tags: string[] } }>;
assert(tagResults.length > 0, `Tag-matched results: ${tagResults.length}`);

// Test 7: Add entry (JSON)
console.log('\n7. Add entry');
const addResult = runJson(['add', '--title', 'Test Entry', '--category', 'pitfall', '--content', 'This is a test', '--tags', 'test,integration']) as { id: string; title: string };
assert(typeof addResult.id === 'string' && addResult.id.length > 10, `Got ID: ${addResult.id}`);
assert(addResult.title === 'Test Entry', `Title matches`);

// Test 8: Get entry
console.log('\n8. Get entry by ID');
const getResult = runJson(['get', addResult.id]) as { id: string; content: string; confidence: number };
assert(getResult.id === addResult.id, `ID matches`);
assert(getResult.content === 'This is a test', `Content matches`);
assert(getResult.confidence === 1.0, `Confidence = 1.0`);

// Test 9: Edit entry
console.log('\n9. Edit entry');
const editResult = runJson(['edit', addResult.id, '--title', 'Updated Entry', '--content', 'Updated content']) as { id: string; title: string; content: string };
assert(editResult.title === 'Updated Entry', `Title updated`);
assert(editResult.content === 'Updated content', `Content updated`);

// Test 10: Confirm entry
console.log('\n10. Confirm (no-op on already 1.0)');
const confirmResult = runJson(['confirm', addResult.id]) as { confidence: number; source: string };
assert(confirmResult.confidence === 1.0, `Confidence = 1.0`);
assert(confirmResult.source === 'ai-confirmed', `Source = ai-confirmed`);

// Test 11: Remove entry
console.log('\n11. Remove entry');
const removeResult = runJson(['remove', addResult.id]) as { removed: string };
assert(removeResult.removed === addResult.id, `Removed correct ID`);

// Test 12: Export
console.log('\n12. Export');
const exportOutput = run(['export']);
assert(exportOutput.includes('# coding-style:'), `Export contains category headers`);
assert(exportOutput.includes('tags:'), `Export contains tags`);
assert(exportOutput.includes('---'), `Export contains separators`);

// Test 13: List with filter
console.log('\n13. List with category filter');
const listResults = runJson(['list', '--category', 'pitfall']) as Array<{ category: string }>;
assert(listResults.length === 3, `Pitfall entries: ${listResults.length}`);
assert(listResults.every(e => e.category === 'pitfall'), `All are pitfall category`);

// Test 14: Search with min-confidence
console.log('\n14. Search with min-confidence 0');
const allResults = runJson(['search', 'import', '--min-confidence', '0']) as Array<unknown>;
assert(allResults.length > 0, `Results with min-confidence=0: ${allResults.length}`);

// Cleanup
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
const walFile = TEST_DB + '-wal';
const shmFile = TEST_DB + '-shm';
if (existsSync(walFile)) unlinkSync(walFile);
if (existsSync(shmFile)) unlinkSync(shmFile);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
