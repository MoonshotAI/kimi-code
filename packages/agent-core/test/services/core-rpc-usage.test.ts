import { globSync, readFileSync } from 'node:fs';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

/**
 * CoreRPC usage inventory — M3 progress baseline.
 *
 * Counts the `this.core.rpc.<method>()` calls that each consumer service
 * domain still makes through the CoreRPC proxy. M3.2–M3.7 will slice those
 * calls into direct in-process domain service calls, driving every count here
 * down to 0. Each phase updates the baseline map downward as it lands.
 *
 * The scan mirrors the milestone's grep baseline exactly: for each domain it
 * globs `src/services/<domain>/*Service.ts` and counts `.rpc.<method>(`
 * occurrences with `/\.rpc\.[a-zA-Z_]+\(/g`. Aggregating the `*Service.ts`
 * glob (rather than a single `<domain>Service.ts`) is what makes the session
 * domain reach 27 — `sessionService.ts` + `sessionQueryService.ts` +
 * `sessionRuntimeService.ts`.
 */

const SERVICES_SRC = join(import.meta.dirname, '..', '..', 'src', 'services');

// Matches the `.rpc.<method>(` call shape. Identical to the milestone grep
// (`\.rpc\.[a-zA-Z_]+\(`) so the vitest counts track the hand-verified
// baseline 1:1.
const RPC_CALL_RE = /\.rpc\.[a-zA-Z_]+\(/g;

/**
 * Per-domain `.rpc.<method>(` baseline, verified 2026-06-21 against the
 * current tree. Keys are the `src/services/<domain>/` directory names; values
 * are the aggregated `*Service.ts` counts. M3 phases lower these to 0.
 */
const BASELINE: Readonly<Record<string, number>> = {
  authSummary: 1,
  config: 2,
  mcp: 4,
  message: 3,
  modelCatalog: 4,
  prompt: 0,
  session: 27,
  skill: 4,
  task: 4,
  tool: 2,
};

function countRpcCalls(domain: string): number {
  const domainDir = join(SERVICES_SRC, domain);
  const files = globSync('*Service.ts', { cwd: domainDir });
  let total = 0;
  for (const file of files) {
    const source = readFileSync(join(domainDir, file), 'utf8');
    RPC_CALL_RE.lastIndex = 0;
    const matches = source.match(RPC_CALL_RE);
    total += matches === null ? 0 : matches.length;
  }
  return total;
}

describe('CoreRPC usage inventory (M3 baseline)', () => {
  it('per-domain .rpc.<method>( counts match the baseline', () => {
    const actual: Record<string, number> = {};
    for (const domain of Object.keys(BASELINE)) {
      actual[domain] = countRpcCalls(domain);
    }
    expect(actual).toEqual(BASELINE);
  });
});
