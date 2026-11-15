import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { ArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ArtexRecordFactTool, type RecordFactInput } from './record_fact/record_fact';
import { ArtexReportFindingTool, type ReportFindingInput } from './report_finding/report_finding';
import { ArtexProveGoalTool, type ProveGoalInput } from './prove_goal/prove_goal';

const SCOPE = { agentId: 'worker-1' } as unknown as IAgentScopeContext;

function sessionContextFor(root: string): IArtexSessionContext {
  let active: number | undefined = 1;
  return {
    _serviceBrand: undefined,
    workspaceRoot: root,
    getActiveExplorationId: () => active,
    setActiveExplorationId: (id) => {
      active = id;
    },
  };
}

async function run(result: Promise<ExecutableToolResult>): Promise<ExecutableToolResult> {
  return result;
}

describe('artex graph tools', () => {
  let dir: string;
  let store: IArtexGraphStore;
  let session: IArtexSessionContext;
  let provider: ArtexGraphStoreProvider;
  let recordFact: ArtexRecordFactTool;
  let reportFinding: ArtexReportFindingTool;
  let proveGoal: ArtexProveGoalTool;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-tools-'));
    provider = new ArtexGraphStoreProvider();
    store = provider.open(dir, 1);
    await store.init('scope', 'capture the flag');
    await store.addGoal({ text: 'capture the flag', summary: 'capture the flag' });
    session = sessionContextFor(dir);
    recordFact = new ArtexRecordFactTool(session, provider, SCOPE);
    reportFinding = new ArtexReportFindingTool(session, provider, SCOPE);
    proveGoal = new ArtexProveGoalTool(session, provider);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function exec<A>(tool: { resolveExecution(a: A): unknown }, args: A): Promise<ExecutableToolResult> {
    const resolved = tool.resolveExecution(args) as {
      execute: (ctx: unknown) => Promise<ExecutableToolResult>;
    };
    return run(resolved.execute({}));
  }

  it('record_fact writes a fact node linked to its intent', async () => {
    const intentId = await store.addIntent({ summary: 'probe login' }, 5);
    const result = await exec<RecordFactInput>(recordFact, {
      summary: 'login form reflects input',
      confidence: 'observed',
      source: 'tool_output',
      intent_id: intentId,
    });
    expect(result.isError ?? false).toBe(false);
    const facts = await store.listByKind('fact');
    expect(facts.some((node) => (node.payload as { summary?: string }).summary === 'login form reflects input')).toBe(true);
  });

  it('prove_goal refuses an inferred fact and accepts an observed non-target fact', async () => {
    const goals = await store.listByKind('goal');
    const goalId = goals[0]!.id;

    const inferred = await store.addNode({
      kind: 'fact',
      payload: { summary: 'probably vulnerable', confidence: 'inferred', source: 'inference' },
      priority: 5,
      state: 'confirmed',
    });
    const refused = await exec<ProveGoalInput>(proveGoal, { goal_id: goalId, evidence_id: inferred });
    expect(refused.isError).toBe(true);

    const observed = await store.addNode({
      kind: 'fact',
      payload: { summary: 'flag read from /flag', confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    const accepted = await exec<ProveGoalInput>(proveGoal, { goal_id: goalId, evidence_id: observed });
    expect(accepted.isError ?? false).toBe(false);
    const updated = await store.getNode(goalId);
    expect(updated?.state).toBe('met');
  });

  it('prove_goal refuses an observed fact sourced from the target response', async () => {
    const goals = await store.listByKind('goal');
    const goalId = goals[0]!.id;
    const planted = await store.addNode({
      kind: 'fact',
      payload: { summary: 'target said it is vulnerable', confidence: 'observed', source: 'target_response' },
      priority: 5,
      state: 'confirmed',
    });
    const refused = await exec<ProveGoalInput>(proveGoal, { goal_id: goalId, evidence_id: planted });
    expect(refused.isError).toBe(true);
    const goal = await store.getNode(goalId);
    expect(goal?.state).toBe('open');
  });

  it('report_finding records a finding and rejects an identical duplicate', async () => {
    const args: ReportFindingInput = {
      vulnclass: 'sqli',
      name: 'login SQL injection',
      severity: 'high',
      summary: 'union-based sqli on /login',
      asset_ids: [7],
      evidence: "' UNION SELECT ... -> 200 with dumped rows",
    };
    const first = await exec<ReportFindingInput>(reportFinding, args);
    expect(first.isError ?? false).toBe(false);
    const findings = await store.listByKind('finding');
    expect(findings).toHaveLength(1);

    const duplicate = await exec<ReportFindingInput>(reportFinding, args);
    expect(duplicate.isError).toBe(true);
    expect(await store.listByKind('finding')).toHaveLength(1);
  });
});
