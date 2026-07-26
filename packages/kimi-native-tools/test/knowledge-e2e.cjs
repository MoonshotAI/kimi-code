/**
 * End-to-end test for the Knowledge Base native module.
 * Tests the complete lifecycle: open → add (pending) → search (excluded) →
 * confirm → search (included) → reject → search (excluded) → stats.
 *
 * Run: node test/knowledge-e2e.cjs
 */

const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const native = require('../kimi-native-tools.win32-x64-msvc.node');

const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-knowledge-test-'));
const dbPath = join(tmpDir, 'knowledge.db');

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  OK ${msg}`);
    pass++;
  } else {
    console.error(`  FAIL ${msg}`);
    fail++;
  }
}

console.log('Knowledge Base E2E Test');
console.log('========================\n');

// 1. Open database
console.log('1. Open database');
try {
  native.knowledgeOpen(dbPath);
  assert(true, `Database opened at ${dbPath}`);
} catch (error) {
  assert(false, `Failed to open database: ${error.message}`);
  process.exit(1);
}

// 2. Add a human entry (should be confirmed by default)
console.log('\n2. Add human entry (auto-confirmed)');
let humanEntry;
try {
  const json = native.knowledgeAdd(
    'Use const by default',
    'coding-style',
    'Always use const instead of let unless reassignment is needed',
    'typescript,import',
    null,
    'human',
    1.0,
    'confirmed',
  );
  humanEntry = JSON.parse(json);
  assert(humanEntry.id !== undefined, 'Human entry created with ID');
  assert(humanEntry.status === 'confirmed', `Status is confirmed (got: ${humanEntry.status})`);
  assert(humanEntry.confidence === 1.0, `Confidence is 1.0 (got: ${humanEntry.confidence})`);
} catch (error) {
  assert(false, `Failed to add human entry: ${error.message}`);
}

// 3. Add an AI-learned entry (should be pending)
console.log('\n3. Add AI-learned entry (pending)');
let aiEntry;
try {
  const json = native.knowledgeAdd(
    'Use pnpm not npm',
    'workflow',
    'Always use pnpm for package management, never npm',
    'git',
    null,
    'ai-learned',
    0.7,
    'pending',
  );
  aiEntry = JSON.parse(json);
  assert(aiEntry.id !== undefined, 'AI entry created with ID');
  assert(aiEntry.status === 'pending', `Status is pending (got: ${aiEntry.status})`);
  assert(aiEntry.confidence === 0.7, `Confidence is 0.7 (got: ${aiEntry.confidence})`);
} catch (error) {
  assert(false, `Failed to add AI entry: ${error.message}`);
}

// 4. Search — should only return confirmed entries
console.log('\n4. Search (should only return confirmed entries)');
try {
  const json = native.knowledgeSearch('const', null, null, 10, 0.5);
  const results = JSON.parse(json);
  assert(results.length === 1, `Found 1 result (got: ${results.length})`);
  if (results.length > 0) {
    assert(
      results[0].entry.title === 'Use const by default',
      `Title matches: ${results[0].entry.title}`,
    );
    assert(results[0].entry.status === 'confirmed', `Result is confirmed`);
  }
} catch (error) {
  assert(false, `Search failed: ${error.message}`);
}

// 5. Search for pending entry — should NOT find it
console.log('\n5. Search for pending entry (should not find it)');
try {
  const json = native.knowledgeSearch('pnpm', null, null, 10, 0.5);
  const results = JSON.parse(json);
  assert(
    results.length === 0,
    `Pending entry not in search results (got: ${results.length} results)`,
  );
} catch (error) {
  assert(false, `Search failed: ${error.message}`);
}

// 6. Confirm the AI-learned entry
console.log('\n6. Confirm AI-learned entry');
try {
  const ok = native.knowledgeConfirm(aiEntry.id);
  assert(ok === true, 'Confirm succeeded');
} catch (error) {
  assert(false, `Confirm failed: ${error.message}`);
}

// 7. Search again — now should find the confirmed entry
console.log('\n7. Search after confirm (should find it now)');
try {
  const json = native.knowledgeSearch('pnpm', null, null, 10, 0.5);
  const results = JSON.parse(json);
  assert(results.length === 1, `Found 1 result (got: ${results.length})`);
  if (results.length > 0) {
    assert(results[0].entry.status === 'confirmed', `Entry is now confirmed`);
    assert(
      results[0].entry.source === 'ai-confirmed',
      `Source is ai-confirmed (got: ${results[0].entry.source})`,
    );
    assert(results[0].entry.confidence === 1.0, `Confidence upgraded to 1.0`);
  }
} catch (error) {
  assert(false, `Search failed: ${error.message}`);
}

// 8. Reject the confirmed entry
console.log('\n8. Reject entry (soft delete)');
try {
  const ok = native.knowledgeReject(aiEntry.id);
  assert(ok === true, 'Reject succeeded');
} catch (error) {
  assert(false, `Reject failed: ${error.message}`);
}

// 9. Search — rejected entry should NOT appear
console.log('\n9. Search after reject (should not find it)');
try {
  const json = native.knowledgeSearch('pnpm', null, null, 10, 0.5);
  const results = JSON.parse(json);
  assert(
    results.length === 0,
    `Rejected entry not in search results (got: ${results.length} results)`,
  );
} catch (error) {
  assert(false, `Search failed: ${error.message}`);
}

// 10. Stats
console.log('\n10. Stats');
try {
  const json = native.knowledgeStats();
  const stats = JSON.parse(json);
  assert(stats.total === 2, `Total entries: 2 (got: ${stats.total})`);
  assert(stats.by_status['confirmed'] === 1, `Confirmed: 1 (got: ${stats.by_status['confirmed']})`);
  assert(stats.by_status['rejected'] === 1, `Rejected: 1 (got: ${stats.by_status['rejected']})`);
  assert(stats.by_category['coding-style'] === 1, `coding-style: 1`);
  assert(stats.by_category['workflow'] === 1, `workflow: 1`);
} catch (error) {
  assert(false, `Stats failed: ${error.message}`);
}

// 11. Dedup test
console.log('\n11. Dedup test (same title+category+source should fail)');
try {
  native.knowledgeAdd(
    'Use const by default',
    'coding-style',
    'Duplicate content',
    '',
    null,
    'human',
    1.0,
    'confirmed',
  );
  assert(false, 'Duplicate should have been rejected');
} catch (error) {
  assert(error.message.includes('Duplicate'), `Duplicate correctly rejected: ${error.message}`);
}

// 12. Input validation
console.log('\n12. Input validation');
try {
  native.knowledgeAdd('', 'coding-style', 'content', '', null, 'human', 1.0, 'confirmed');
  assert(false, 'Empty title should fail');
} catch (error) {
  assert(error.message.includes('title'), `Empty title rejected: ${error.message}`);
}

try {
  native.knowledgeAdd('Test', 'coding-style', 'content', '', null, 'human', 2.0, 'confirmed');
  assert(false, 'Confidence > 1.0 should fail');
} catch (error) {
  assert(error.message.includes('confidence'), `Invalid confidence rejected: ${error.message}`);
}

// 13. Tag search
console.log('\n13. Tag search');
try {
  const json = native.knowledgeSearch('', null, 'typescript', 10, 0.5);
  const results = JSON.parse(json);
  assert(results.length === 1, `Found 1 result by tag (got: ${results.length})`);
  if (results.length > 0) {
    assert(results[0].entry.tags.includes('typescript'), `Entry has typescript tag`);
  }
} catch (error) {
  assert(false, `Tag search failed: ${error.message}`);
}

// Cleanup (best-effort, ignore WAL lock errors on Windows)
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {}

console.log(`\n========================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
