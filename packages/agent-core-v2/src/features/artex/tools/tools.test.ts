import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { ArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexTrafficStoreProvider } from '#/features/artex/store/artexTrafficStoreProvider';
import type { FileArtexTrafficStore } from '#/features/artex/store/fileArtexTrafficStore';
import type { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { ArtexRecordFactTool, type RecordFactInput } from './record_fact/record_fact';
import { ArtexReportFindingTool, type ReportFindingInput } from './report_finding/report_finding';
import { ArtexProveGoalTool, type ProveGoalInput } from './prove_goal/prove_goal';
import { ArtexGoalMetTool, type GoalMetInput } from './goal_met/goal_met';
import { ArtexGraphOverviewTool } from './graph_overview/graph_overview';
import { ArtexGetWorkerOutputTool, type GetWorkerOutputInput } from './get_worker_output/get_worker_output';
import { ArtexGetWorkerTraceTool, type GetWorkerTraceInput } from './get_worker_trace/get_worker_trace';
import {
  ArtexSearchAllWorkerTracesTool,
  type SearchAllWorkerTracesInput,
} from './search_all_worker_traces/search_all_worker_traces';
import {
  ArtexListWorkerTracesTool,
  type ListWorkerTracesInput,
} from './list_worker_traces/list_worker_traces';
import { ArtexExpandDigestTool, type ExpandDigestInput } from './expand_digest/expand_digest';
import {
  ArtexStartExplorationTool,
  type StartArtexExplorationInput,
} from './start_artex_exploration/start_artex_exploration';
import { ArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { IArtexOrchestrator } from '#/features/artex/engine/artexOrchestrator';
import type { IArtexModeService } from '#/features/artex/agent/artexMode';
import { ArtexListAssetsTool, type ListAssetsInput } from './list_assets/list_assets';
import { ArtexListFactsTool, type ListFactsInput } from './list_facts/list_facts';
import { ArtexNodeDetailTool, type NodeDetailInput } from './node_detail/node_detail';
import { ArtexRecordCoverageTool, type RecordCoverageInput } from './record_coverage/record_coverage';
import { ArtexSetConstraintsTool, type SetConstraintsInput } from './set_constraints/set_constraints';
import { ArtexSetGoalsTool, type SetGoalsInput } from './set_goals/set_goals';
import { stubFlag } from '../../../../test/app/flag/stubs';
import { vi } from 'vitest';

function recordingRecorderFor(store: FileArtexTrafficStore): IArtexTrafficRecorder {
  return {
    _serviceBrand: undefined,
    state: { status: 'recording', proxyUrl: 'http://127.0.0.1:0' },
    isRecording: true,
    ensureStarted: async () => ({ status: 'recording', proxyUrl: 'http://127.0.0.1:0' }),
    stop: async () => {},
    store: () => store,
    proxyEnvOverlay: () => undefined,
  } as unknown as IArtexTrafficRecorder;
}

async function recordProofExchange(store: FileArtexTrafficStore, body: string): Promise<string> {
  return store.record({
    host: '10.0.0.5',
    method: 'GET',
    url: 'http://10.0.0.5/admin/users.json',
    status: 200,
    contentType: 'application/json',
    reqHead: 'GET /admin/users.json HTTP/1.1',
    respHead: 'HTTP 200\nContent-Type: application/json',
    reqBody: Buffer.from(''),
    respBody: Buffer.from(body),
  });
}

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

function parseOutput<T>(result: ExecutableToolResult): T {
  return JSON.parse(typeof result.output === 'string' ? result.output : '{}') as T;
}

describe('artex graph tools', () => {
  let dir: string;
  let store: IArtexGraphStore;
  let session: IArtexSessionContext;
  let provider: ArtexGraphStoreProvider;
  let recordFact: ArtexRecordFactTool;
  let reportFinding: ArtexReportFindingTool;
  let proveGoal: ArtexProveGoalTool;
  let trafficStore: FileArtexTrafficStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-tools-'));
    provider = new ArtexGraphStoreProvider();
    store = provider.open(dir, 1);
    await store.init('scope', 'capture the flag');
    await store.addGoal({ text: 'capture the flag', summary: 'capture the flag' });
    session = sessionContextFor(dir);
    trafficStore = new ArtexTrafficStoreProvider().open(dir);
    recordFact = new ArtexRecordFactTool(session, provider, SCOPE);
    reportFinding = new ArtexReportFindingTool(session, provider, SCOPE, recordingRecorderFor(trafficStore));
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

  it('report_finding binds proof traffic and marks verified when a quote matches byte-for-byte', async () => {
    const trafficId = await recordProofExchange(trafficStore, '{"users":[{"name":"root","role":"admin"}]}');
    const result = await exec<ReportFindingInput>(reportFinding, {
      vulnclass: 'idor',
      name: 'admin user dump',
      severity: 'high',
      summary: 'unauthenticated admin user listing',
      evidence: 'GET /admin/users.json -> 200 with user records',
      confidence_level: 3,
      traffic_refs: [{ traffic_id: trafficId, role: 'proof', note: 'the admin dump' }],
      evidence_quotes: ['"name":"root","role":"admin"'],
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(typeof result.output === 'string' ? result.output : '{}') as {
      evidence_status: string;
      verification_status: string;
      bound_traffic: number;
    };
    expect(payload.bound_traffic).toBe(1);
    expect(payload.evidence_status).toBe('bound');
    expect(payload.verification_status).toBe('verified');
    const finding = (await store.listByKind('finding'))[0]!;
    const stored = finding.payload as { verification_status?: string; confidence_level?: number };
    expect(stored.verification_status).toBe('verified');
    expect(stored.confidence_level).toBe(3);
  });

  it('report_finding stays unverified when a quote is not present verbatim in bound evidence', async () => {
    const trafficId = await recordProofExchange(trafficStore, '{"users":[{"name":"root","role":"admin"}]}');
    const result = await exec<ReportFindingInput>(reportFinding, {
      vulnclass: 'idor',
      name: 'admin user dump 2',
      severity: 'high',
      summary: 'unauthenticated admin user listing',
      evidence: 'GET /admin/users.json -> 200',
      confidence_level: 3,
      traffic_refs: [{ traffic_id: trafficId, role: 'proof' }],
      evidence_quotes: ['"name":"superuser"'],
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(typeof result.output === 'string' ? result.output : '{}') as {
      verification_status: string;
      verification_note: string;
    };
    expect(payload.verification_status).toBe('unverified');
    expect(payload.verification_note).toContain('not found verbatim');
  });

  it('report_finding refuses an unknown traffic ref without saving the finding', async () => {
    const before = (await store.listByKind('finding')).length;
    const result = await exec<ReportFindingInput>(reportFinding, {
      vulnclass: 'idor',
      name: 'phantom',
      summary: 'bad ref',
      confidence_level: 3,
      traffic_refs: [{ traffic_id: '0000-9999', role: 'proof' }],
    });
    expect(result.isError).toBe(true);
    expect(await store.listByKind('finding')).toHaveLength(before);
  });

  it('goal_met persists achieved status and notifies orchestrator once all goals are met', async () => {
    const notifyGoalMet = vi.fn();
    const goalMet = new ArtexGoalMetTool(session, provider, {
      notifyGoalMet,
    } as unknown as IArtexOrchestrator);

    const refused = await exec<GoalMetInput>(goalMet, { reason: 'done' });
    expect(refused.isError).toBe(true);

    const goals = await store.listByKind('goal');
    for (const g of goals) await store.setNodeState(g.id, 'met');

    const accepted = await exec<GoalMetInput>(goalMet, { reason: 'all objectives verified' });
    expect(accepted.isError ?? false).toBe(false);
    const exp = await store.exploration();
    expect(exp.status).toBe('achieved');
    expect(exp.goalMetAt).toBeDefined();
    expect(exp.goalMetReason).toBe('all objectives verified');
    expect(notifyGoalMet).toHaveBeenCalledWith(1, 'all objectives verified');
  });

  it('get_worker_output, get_worker_trace, search_all_worker_traces, and list_worker_traces read live activity.log', async () => {
    const intent1 = await store.addIntent({ summary: 'scan auth endpoints' }, 8);
    const intent2 = await store.addIntent({ summary: 'check upload handler' }, 6);
    await store.setIntentState(intent1, 'running');
    await store.setIntentState(intent2, 'done');

    await store.appendActivity({
      nodeId: intent1,
      actor: 'worker-1',
      kind: 'thinking',
      summary: 'internal secret thought',
      text: 'internal secret thought',
    });
    const s1 = await store.appendActivity({
      nodeId: intent1,
      actor: 'worker-1',
      kind: 'tool_use',
      tool: 'Bash',
      summary: 'Bash curl http://target.example.com/admin',
      text: 'curl http://target.example.com/admin',
      detail: { command: 'curl http://target.example.com/admin' },
    });
    const s2 = await store.appendActivity({
      nodeId: intent1,
      actor: 'worker-1',
      kind: 'tool_result',
      tool: 'Bash',
      summary: '200 OK admin_token=xyz',
      text: 'HTTP/1.1 200 OK\nadmin_token=xyz',
    });
    await store.appendActivity({
      nodeId: intent2,
      actor: 'worker-2',
      kind: 'tool_result',
      tool: 'FetchURL',
      summary: 'upload returned 403',
      text: 'upload returned 403',
    });

    const workerOutput = new ArtexGetWorkerOutputTool(session, provider);
    const liveOut = await exec<GetWorkerOutputInput>(workerOutput, { intent_id: intent1 });
    expect(liveOut.isError ?? false).toBe(false);
    const parsedLive = parseOutput<{
      state: string;
      live_steps: Array<{ step_id: number }>;
    }>(liveOut);
    expect(parsedLive.state).toBe('running');
    expect(parsedLive.live_steps.map((s) => s.step_id)).toEqual([s1, s2]);

    const workerTrace = new ArtexGetWorkerTraceTool(session, provider);
    const listSteps = await exec<GetWorkerTraceInput>(workerTrace, { intent_id: intent1 });
    const traceSummary = parseOutput<{
      steps: Array<{ step_id: number; kind: string }>;
    }>(listSteps);
    expect(traceSummary.steps.map((s) => s.step_id)).toEqual([s1, s2]);

    const detail = await exec<GetWorkerTraceInput>(workerTrace, {
      intent_id: intent1,
      step_ids: [s1, s2, 9001, 9002, 9003, 9004],
    });
    const parsedDetail = parseOutput<{
      returned_step_ids: number[];
      omitted_step_ids: number[];
      steps: Array<{ step_id: number; text?: string }>;
    }>(detail);
    expect(parsedDetail.returned_step_ids).toHaveLength(5);
    expect(parsedDetail.omitted_step_ids).toEqual([9004]);
    expect(parsedDetail.steps.find((s) => s.step_id === s2)?.text).toContain('admin_token=xyz');

    const searchAll = new ArtexSearchAllWorkerTracesTool(session, provider, {
      agentId: 'worker-2',
      meta: { labels: { artexIntentId: String(intent2) } },
    } as unknown as IAgentScopeContext);
    const hitsRes = await exec<SearchAllWorkerTracesInput>(searchAll, { q: 'admin_token' });
    const hits = parseOutput<{
      hits: Array<{ intent_id: number; step_id: number }>;
    }>(hitsRes);
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.intent_id).toBe(intent1);

    const listTraces = new ArtexListWorkerTracesTool(session, provider);
    const listed = parseOutput<{ works: Array<{ intent_id: number; state: string }> }>(
      await exec<ListWorkerTracesInput>(listTraces, { q: 'upload' }),
    );
    expect(listed.works).toEqual([{ intent_id: intent2, summary: 'check upload handler', state: 'done' }]);
  });

  it('expand_digest and graph_overview surface cold digests, revival check, and stagnation warnings', async () => {
    const d1 = await store.addIntent({ summary: 'probe /api/v1/user/1' }, 5);
    const d2 = await store.addIntent({ summary: 'probe /api/v1/user/2' }, 5);
    const d3 = await store.addIntent({ summary: 'probe /api/v1/user/3' }, 5);
    await store.setIntentState(d1, 'done');
    await store.setIntentState(d2, 'done');
    await store.setIntentState(d3, 'done');

    const digestId = await store.addDigest(
      { body: 'Probed user endpoints (#1,#2) with no findings.' },
      [d1, d2],
    );

    const expand = new ArtexExpandDigestTool(session, provider);
    const expanded = parseOutput<{ id: number; body: string; members: Array<{ id: number }> }>(
      await exec<ExpandDigestInput>(expand, { id: digestId }),
    );
    expect(expanded.id).toBe(digestId);
    expect(expanded.members.map((m) => m.id)).toEqual([d1, d2]);

    const workProvider = new ArtexWorkStoreProvider();
    const overviewTool = new ArtexGraphOverviewTool(session, provider, workProvider);
    const overview = parseOutput<{
      cold_digests?: Array<{ id: number }>;
      recent_done_intents: Array<{ id: number }>;
      stagnation_warning?: { directions: Array<{ repeats: number }> };
    }>(await exec(overviewTool, {}));
    expect(overview.cold_digests?.map((d) => d.id)).toEqual([digestId]);
    expect(overview.recent_done_intents.map((i) => i.id)).toEqual([d3]);
    expect(overview.stagnation_warning?.directions[0]?.repeats).toBe(3);

    const revivedIntent = await store.addIntent({ summary: 'recheck user/1' }, 9);
    await store.link(d1, 'derived_from', revivedIntent);
    const revivedOverview = parseOutput<{ recent_done_intents: Array<{ id: number }> }>(
      await exec(overviewTool, {}),
    );
    expect(revivedOverview.recent_done_intents.some((i) => i.id === d1)).toBe(true);
  });

  it('start_artex_exploration initializes exploration, enters mode, and drives orchestrator start/pause/status', async () => {
    const localSession = sessionContextFor(dir);
    localSession.setActiveExplorationId(undefined);
    const start = vi.fn(() => ({
      explorationId: 1,
      completion: Promise.resolve({
        waves: 0,
        dispatched: 0,
        settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
        goalMet: false,
        stalled: false,
        stopped: false,
      }),
      stop: () => {},
    }));
    const pause = vi.fn(async () => true);
    const getStatus = vi.fn((id: number) => ({
      explorationId: id,
      running: true,
      paused: false,
      activeWorkers: 12,
      waves: 1,
      dispatched: 12,
      settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
      goalMet: false,
      stalled: false,
      stopped: false,
    }));
    const enter = vi.fn();
    const entryTool = new ArtexStartExplorationTool(
      localSession,
      provider,
      { start, pause, getStatus } as unknown as IArtexOrchestrator,
      { enter } as unknown as IArtexModeService,
      { agentId: 'main' } as unknown as IAgentScopeContext,
      stubFlag(true),
    );

    const started = await exec<StartArtexExplorationInput>(entryTool, {
      goal: 'find SQL injection',
      description: 'https://target.example.com',
      target_concurrency: 120,
    });
    expect(started.isError ?? false).toBe(false);
    expect(localSession.getActiveExplorationId()).toBe(2);
    expect(enter).toHaveBeenCalledWith(2);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ explorationId: 2, targetConcurrency: 120 }),
    );

    const statusRes = await exec<StartArtexExplorationInput>(entryTool, { action: 'status' });
    expect(parseOutput(statusRes)).toMatchObject({
      exploration_id: 2,
      initialized: true,
      status: { running: true, activeWorkers: 12 },
    });

    const pauseRes = await exec<StartArtexExplorationInput>(entryTool, { action: 'pause' });
    expect(pause).toHaveBeenCalledWith(2);
    expect(parseOutput(pauseRes)).toMatchObject({ paused: true });
  });

  it('supports upgraded parity behavior across list_assets, set_goals, graph_overview, node_detail, list_facts, set_constraints, and record_coverage', async () => {
    const workProvider = new ArtexWorkStoreProvider();
    const workStore = workProvider.open(dir);
    await workStore.ensureSeeded();
    await workStore.upsertAsset(
      { type: 'service', url: 'https://portal.example.test:8443/login', statusCode: 200, technologies: ['React'] },
      1,
    );
    await workStore.addTaskScope(1, 'root_domain', 'example.test', 'declared', 'agent');
    await workStore.upsertTaskCredential(1, {
      domain: 'example.test',
      username: 'tester@example.test',
      password: 'top-secret-value',
      source: 'user',
    });

    const listAssets = new ArtexListAssetsTool(session, workProvider);
    const dslRes = parseOutput<{ count: number; assets: Array<{ url?: string }> }>(
      await exec<ListAssetsInput>(listAssets, { dsl: 'port>=8000 AND technology=react' }),
    );
    expect(dslRes.count).toBe(1);
    expect(dslRes.assets[0]?.url).toContain('portal.example.test');
    const badDsl = await exec<ListAssetsInput>(listAssets, { dsl: 'port=abc' });
    expect(badDsl.isError).toBe(true);

    const setGoals = new ArtexSetGoalsTool(session, provider);
    const goalsOut = parseOutput<{ ids: number[] }>(
      await exec<SetGoalsInput>(setGoals, {
        goals: [
          { text: 'dump admin table', category: 'sqli' },
          { text: 'bypass auth', vulnclass: 'auth_bypass' },
          'plain string goal',
        ],
      }),
    );
    expect(goalsOut.ids).toHaveLength(3);
    const g1 = await store.getNode(goalsOut.ids[0]!);
    const g2 = await store.getNode(goalsOut.ids[1]!);
    expect((g1?.payload as { category?: string }).category).toBe('sqli');
    expect((g2?.payload as { category?: string }).category).toBe('auth_bypass');

    const longSummary = 'S'.repeat(190);
    const f1 = await store.addNode({
      kind: 'fact',
      payload: { summary: `alpha ${longSummary}`, confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    const f2 = await store.addNode({
      kind: 'fact',
      payload: { summary: 'beta second fact', confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    const f3 = await store.addNode({
      kind: 'fact',
      payload: { summary: 'alpha third fact', confidence: 'observed', source: 'tool_output' },
      priority: 5,
      state: 'confirmed',
    });
    const listFacts = new ArtexListFactsTool(session, provider);
    const page1 = parseOutput<{
      facts: Array<{ id: number; summary: string; summary_truncated?: boolean }>;
      total: number;
      has_more: boolean;
      next_before?: number;
    }>(await exec<ListFactsInput>(listFacts, { q: 'alpha', limit: 1 }));
    expect(page1.total).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.facts[0]?.id).toBe(f3);
    expect(page1.next_before).toBe(f3);

    const page2 = parseOutput<{
      facts: Array<{ id: number; summary: string; summary_truncated?: boolean }>;
      has_more: boolean;
    }>(await exec<ListFactsInput>(listFacts, { q: 'alpha', before: page1.next_before, limit: 1 }));
    expect(page2.has_more).toBe(false);
    expect(page2.facts[0]?.id).toBe(f1);
    expect(page2.facts[0]?.summary_truncated).toBe(true);
    expect(Array.from(page2.facts[0]!.summary).length).toBe(161);
    void f2;

    const trafficProvider = new ArtexTrafficStoreProvider();
    const traffic = trafficProvider.open(dir);
    const tid = await recordProofExchange(traffic, '{"ok":true}');
    const findingId = await store.addNode({
      kind: 'finding',
      payload: { summary: 'test finding', vulnclass: 'idor', name: 'idor' },
      priority: 5,
      state: 'confirmed',
    });
    await traffic.bindToFinding(findingId, [{ trafficId: tid, role: 'proof' }]);

    const nodeDetail = new ArtexNodeDetailTool(session, provider, trafficProvider);
    const detailById = parseOutput<{
      node: { id: number };
      finding_id?: number;
      traffic_count?: number;
    }>(await exec<NodeDetailInput>(nodeDetail, { id: findingId }));
    expect(detailById.node.id).toBe(findingId);
    expect(detailById.finding_id).toBe(findingId);
    expect(detailById.traffic_count).toBe(1);

    const detailByNodeId = parseOutput<{ node: { id: number } }>(
      await exec<NodeDetailInput>(nodeDetail, { node_id: findingId }),
    );
    expect(detailByNodeId.node.id).toBe(findingId);

    const setConstraints = new ArtexSetConstraintsTool(session, workProvider, SCOPE);
    await exec<SetConstraintsInput>(setConstraints, { text: 'only https', type: 'allow' });
    const firstConstraints = await workStore.listConstraints(1);
    await exec<SetConstraintsInput>(setConstraints, { text: 'no dos', type: 'deny' });
    const allConstraints = await workStore.listConstraints(1);
    expect(allConstraints).toHaveLength(2);
    expect(allConstraints[0]?.id).toBe(firstConstraints[0]?.id);

    const recordCoverage = new ArtexRecordCoverageTool(session, workProvider, SCOPE);
    const covRes = await exec<RecordCoverageInput>(recordCoverage, {
      surface: 'https://portal.example.test:8443/login',
      risk_area: 'sqli',
      outcome: 'no_issue_found',
      evidence: 'tested payload',
      intent_id: 99,
    });
    expect(covRes.isError ?? false).toBe(false);
    expect((await workStore.coverageEntries(1))[0]?.intentId).toBe(99);

    const overviewTool = new ArtexGraphOverviewTool(session, provider, workProvider);
    const overview = parseOutput<{
      hidden_node_count: number;
      coverage?: { denominator: number; ledger_entries: number };
      task_credentials?: Array<{ username: string; password?: string; has_password?: boolean }>;
    }>(await exec(overviewTool, {}));
    expect(typeof overview.hidden_node_count).toBe('number');
    expect(overview.coverage?.denominator).toBe(1);
    expect(overview.coverage?.ledger_entries).toBe(1);
    expect(overview.task_credentials?.[0]?.username).toBe('tester@example.test');
    expect(overview.task_credentials?.[0]?.password).toBeUndefined();
    expect(overview.task_credentials?.[0]?.has_password).toBe(true);
  });
});
