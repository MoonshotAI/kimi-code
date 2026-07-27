import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverWorkflows } from '#/app/workflow/runtime/discovery';
import { runWorkflowScript } from '#/app/workflow/runtime/runtime';
import {
  DEFAULT_WORKFLOW_LIMITS,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowLimits,
} from '#/app/workflow/runtime/types';

const BUILTIN_DIR = path.join(path.dirname(import.meta.filename), '../../../src/app/workflow/builtin');
const SCRIPT_PATH = path.join(BUILTIN_DIR, 'deep-research.js');

async function loadDeepResearch(): Promise<WorkflowDefinition> {
  const script = await fs.readFile(SCRIPT_PATH, 'utf8');
  return {
    meta: {
      name: 'deep-research',
      description: 'deep research',
      phases: [
        { title: 'Scope' },
        { title: 'Search' },
        { title: 'Fetch' },
        { title: 'Verify' },
        { title: 'Synthesize' },
      ],
    },
    script,
    path: SCRIPT_PATH,
    source: 'builtin',
  };
}

function limits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
  return { ...DEFAULT_WORKFLOW_LIMITS, maxDurationMs: 30_000, ...overrides };
}

interface StubOptions {
  angles?: { label: string; query: string }[];
  searchResults?: Record<
    string,
    { url: string; title: string; snippet?: string; relevance: 'high' | 'medium' | 'low' }[]
  >;
  verdict?: (claimLabel: string) => { refuted: boolean; evidence: string; confidence: string } | null;
}

/** Programmable host: answers by label prefix (scope / search: / fetch: / vote: / synthesize). */
function stubHost(options: StubOptions = {}): { host: WorkflowHost; calls: WorkflowAgentRequest[] } {
  const calls: WorkflowAgentRequest[] = [];
  const host: WorkflowHost = {
    async runAgent(request): Promise<WorkflowAgentOutcome> {
      calls.push(request);
      const label = request.label ?? '';
      const ok = (payload: unknown): WorkflowAgentOutcome => ({ status: 'ok', text: JSON.stringify(payload) });

      if (label === 'scope') {
        return ok({
          question: 'Q',
          strategy: 's',
          angles: options.angles ?? [
            { label: 'a1', query: 'q1' },
            { label: 'a2', query: 'q2' },
            { label: 'a3', query: 'q3' },
            { label: 'a4', query: 'q4' },
          ],
        });
      }
      if (label.startsWith('search:')) {
        const angle = label.slice('search:'.length);
        return ok({ results: options.searchResults?.[angle] ?? [] });
      }
      if (label.startsWith('fetch:')) {
        return ok({
          sourceQuality: 'secondary',
          claims: [{ claim: 'c1', quote: 'q1', importance: 'central' }],
        });
      }
      if (label.startsWith('vote:')) {
        const verdict = options.verdict?.(label);
        if (verdict === null || verdict === undefined) return { status: 'refused' };
        return ok(verdict);
      }
      if (label === 'synthesize') {
        return ok({
          summary: 'exec summary',
          findings: [{ claim: 'c1', confidence: 'high', sources: ['u'], evidence: 'e' }],
          caveats: 'caveats',
        });
      }
      return { status: 'error', message: `unexpected label: ${label}` };
    },
  };
  return { host, calls };
}

describe('builtin deep-research', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-deep-research-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('is discoverable from the builtin root with 5 phases', async () => {
    const { workflows, skipped } = await discoverWorkflows({
      workDir: tmp,
      osHome: tmp,
      includeBuiltin: true,
    });
    expect(skipped).toEqual([]);
    const dr = workflows.find((w) => w.meta.name === 'deep-research');
    expect(dr).toBeDefined();
    expect(dr?.source).toBe('builtin');
    expect(dr?.meta.phases.map((p) => p.title)).toEqual(['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize']);
  });

  it('completes the happy path with dedupe, verification and a cited report', async () => {
    const def = await loadDeepResearch();
    const shared = { url: 'https://a.test/x', title: 'A', relevance: 'high' as const };
    const { host, calls } = stubHost({
      searchResults: {
        a1: [shared, { url: 'https://b.test/y', title: 'B', relevance: 'medium' }],
        a2: [shared], // dupe of a1's first result
        a3: [{ url: 'https://c.test/z', title: 'C', relevance: 'low' }],
        a4: [],
      },
      verdict: () => ({ refuted: false, evidence: 'supported', confidence: 'high' }),
    });
    const phases: string[] = [];
    const result = await runWorkflowScript(def, {
      args: 'What is X?',
      host,
      limits: limits(),
      signal: new AbortController().signal,
      events: { onPhase: (t) => phases.push(t) },
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const out = result.result as {
      findings: unknown[];
      refuted: unknown[];
      stats: Record<string, number>;
    };
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.stats['urlDupes']).toBeGreaterThan(0);
    expect(out.stats['confirmed']).toBeGreaterThan(0);
    expect(phases).toEqual(['Scope', 'Search', 'Verify', 'Synthesize']);
    // 1 scope + 4 search + 3 fetch + 3 claims × 3 votes + 1 synth
    expect(calls.length).toBe(1 + 4 + 3 + 9 + 1);
  });
});
