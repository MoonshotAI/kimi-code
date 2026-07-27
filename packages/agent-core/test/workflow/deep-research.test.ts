import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverWorkflows } from '../../src/workflow/discovery';
import { runWorkflowScript } from '../../src/workflow/runtime';
import {
  DEFAULT_WORKFLOW_LIMITS,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowLimits,
} from '../../src/workflow/types';

const BUILTIN_DIR = path.join(path.dirname(import.meta.filename), '../../src/workflow/builtin');
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
  extract?: Record<string, { sourceQuality: string; claims: { claim: string; quote: string; importance: string }[] }>;
  /** Fallback extraction payload for any fetch label not present in `extract`. */
  extractAll?: { sourceQuality: string; claims: { claim: string; quote: string; importance: string }[] };
  verdict?: (claimLabel: string) => { refuted: boolean; evidence: string; confidence: string } | null;
  report?: { summary: string; findings: unknown[]; caveats: string } | null;
  hangSearch?: boolean;
  onCall?: (request: WorkflowAgentRequest) => void;
}

/** Programmable host: answers by label prefix (scope / search: / fetch: / vote: / synthesize). */
function stubHost(options: StubOptions = {}): { host: WorkflowHost; calls: WorkflowAgentRequest[] } {
  const calls: WorkflowAgentRequest[] = [];
  const host: WorkflowHost = {
    async runAgent(request, signal): Promise<WorkflowAgentOutcome> {
      calls.push(request);
      options.onCall?.(request);
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
        if (options.hangSearch === true) {
          await new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        const angle = label.slice('search:'.length);
        return ok({ results: options.searchResults?.[angle] ?? [] });
      }
      if (label.startsWith('fetch:')) {
        const payload = options.extract?.[label] ??
          options.extractAll ?? {
            sourceQuality: 'secondary',
            claims: [{ claim: 'c1', quote: 'q1', importance: 'central' }],
          };
        return ok(payload);
      }
      if (label.startsWith('vote:')) {
        const verdict = options.verdict?.(label);
        if (verdict === null || verdict === undefined) return { status: 'refused' };
        return ok(verdict);
      }
      if (label === 'synthesize') {
        if (options.report === null) return { status: 'refused' };
        return ok(
          options.report ?? {
            summary: 'exec summary',
            findings: [{ claim: 'c1', confidence: 'high', sources: ['u'], evidence: 'e' }],
            caveats: 'caveats',
          },
        );
      }
      return { status: 'error', message: `unexpected label: ${label}` };
    },
  };
  return { host, calls };
}

function run(def: WorkflowDefinition, options: { host: WorkflowHost; args?: string; signal?: AbortSignal; events?: { onPhase?: (t: string) => void } }) {
  return runWorkflowScript(def, {
    args: options.args ?? 'What is X?',
    host: options.host,
    limits: limits(),
    signal: options.signal ?? new AbortController().signal,
    events: options.events,
  });
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
    const result = await run(def, { host, events: { onPhase: (t) => phases.push(t) } });

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

  it('returns an explicit error when no question is provided', async () => {
    const def = await loadDeepResearch();
    const { host, calls } = stubHost();
    const result = await run(def, { host, args: '   ' });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect((result.result as { error?: string }).error).toContain('No research question');
    expect(calls).toHaveLength(0);
  });

  it('never reports success when every claim is refuted', async () => {
    const def = await loadDeepResearch();
    const { host } = stubHost({
      searchResults: { a1: [{ url: 'https://a.test/x', title: 'A', relevance: 'high' }] },
      verdict: () => ({ refuted: true, evidence: 'contradicted', confidence: 'high' }),
    });
    const result = await run(def, { host });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const out = result.result as { findings: unknown[]; refuted: unknown[]; summary: string };
    expect(out.findings).toEqual([]);
    expect(out.refuted.length).toBeGreaterThan(0);
    expect(out.summary).toContain('inconclusive');
  });

  it('does not let mass abstention pass as confirmed', async () => {
    const def = await loadDeepResearch();
    const { host } = stubHost({
      searchResults: { a1: [{ url: 'https://a.test/x', title: 'A', relevance: 'high' }] },
      verdict: () => null, // every vote refused → abstain
    });
    const result = await run(def, { host });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const out = result.result as { findings: unknown[]; stats: Record<string, number> };
    expect(out.findings).toEqual([]);
    expect(out.stats['confirmed']).toBe(0);
  });

  it('cancels cleanly when aborted mid-run', async () => {
    const def = await loadDeepResearch();
    const controller = new AbortController();
    const { host } = stubHost({ hangSearch: true, onCall: (r) => r.label?.startsWith('search:') && controller.abort() });
    const result = await run(def, { host, signal: controller.signal });
    expect(result.status).toBe('cancelled');
  });

  it('stays within the agent-call budget in the worst case', async () => {
    const def = await loadDeepResearch();
    // 6 angles × 6 unique URLs each = 36 candidates; MAX_FETCH (12) caps fetches.
    const manyClaims = {
      sourceQuality: 'primary',
      claims: Array.from({ length: 5 }, (_, i) => ({ claim: `c${i}`, quote: 'q', importance: 'central' })),
    };
    const { host, calls } = stubHost({
      angles: Array.from({ length: 6 }, (_, i) => ({ label: `a${i}`, query: `q${i}` })),
      searchResults: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `a${i}`,
          Array.from({ length: 6 }, (_, j) => ({
            url: `https://h${j}.test/p${i}`,
            title: `T${i}-${j}`,
            relevance: 'high' as const,
          })),
        ]),
      ),
      extractAll: manyClaims,
      verdict: () => ({ refuted: false, evidence: 'ok', confidence: 'high' }),
    });
    const result = await run(def, { host });
    expect(result.status).toBe('completed');
    // 1 scope + 6 search + 12 fetch + 10×3 verify + 1 synth = 50
    expect(calls.length).toBe(50);
  });
});
