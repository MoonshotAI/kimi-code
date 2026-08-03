#!/usr/bin/env -S npx tsx
/**
 * One-shot analyzer entry point. Writes the current `Graph` snapshot to
 * `.local/dep-graph.json` (git-ignored) so it can be diffed, committed to a
 * scratch review branch, or piped to another tool without running the dev
 * server.
 *
 *     pnpm dep-graph:analyze
 *
 * The dev server (`pnpm dep-graph:dev`) writes the same file continuously
 * while running — this CLI is for CI, hooks, or offline inspection.
 */

import { SNAPSHOT_PATH, analyze, readHeadSha, summarize, writeSnapshot } from './analyzer/analyze';

const graph = analyze({ generatedAt: readHeadSha() ?? new Date().toISOString() });
writeSnapshot(graph);
console.log(`wrote ${SNAPSHOT_PATH}\n  ${summarize(graph)}`);
if (graph.unknownTokens.length > 0) {
  console.log(`  unknownTokens=${graph.unknownTokens.length}: ${graph.unknownTokens.join(', ')}`);
}
