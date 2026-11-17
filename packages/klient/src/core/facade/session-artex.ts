import type { ScopedCaller } from './session.js';
import type { ScopeRef } from '../channel.js';

export interface SessionArtexFacade {
  status(explorationId?: number): Promise<Record<string, unknown>>;
  start(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  control(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  graph(explorationId?: number): Promise<Record<string, unknown>>;
  nodeDetail(nodeId: number, explorationId?: number): Promise<Record<string, unknown> | undefined>;
  activity(query?: Record<string, unknown>): Promise<Record<string, unknown>>;
  findings(explorationId?: number): Promise<readonly Record<string, unknown>[]>;
  patchFinding(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  goals(explorationId?: number): Promise<readonly Record<string, unknown>[]>;
  addGoal(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  editGoal(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteGoal(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  constraints(explorationId?: number): Promise<Record<string, unknown>>;
  setConstraints(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  scope(explorationId?: number): Promise<Record<string, unknown>>;
  addScope(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteScope(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  credentials(explorationId?: number): Promise<readonly Record<string, unknown>[]>;
  saveCredential(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteCredential(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  coverage(explorationId?: number): Promise<Record<string, unknown>>;
  untestedAssets(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  intentControl(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  trafficHosts(): Promise<readonly Record<string, unknown>[]>;
  trafficSearch(query: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
  trafficExchange(trafficId: string): Promise<Record<string, unknown> | undefined>;
  trafficBlob(input: { hash: string; offset?: number; length?: number }): Promise<
    { dataBase64: string; total: number } | undefined
  >;
  ingestTraffic(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  targetPins(input?: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
  revokeTargetPin(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  exportReport(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createSessionArtexFacade(call: ScopedCaller, scope: ScopeRef): SessionArtexFacade {
  const svc = 'artexSessionService';
  return {
    status: (explorationId) => call(scope, svc, 'status', [explorationId]) as Promise<Record<string, unknown>>,
    start: (input) => call(scope, svc, 'start', [input]) as Promise<Record<string, unknown>>,
    control: (input) => call(scope, svc, 'control', [input]) as Promise<Record<string, unknown>>,
    graph: (explorationId) => call(scope, svc, 'graph', [explorationId]) as Promise<Record<string, unknown>>,
    nodeDetail: (nodeId, explorationId) =>
      call(scope, svc, 'nodeDetail', [nodeId, explorationId]) as Promise<
        Record<string, unknown> | undefined
      >,
    activity: (query) =>
      call(scope, svc, 'activity', query === undefined ? [] : [query]) as Promise<Record<string, unknown>>,
    findings: (explorationId) =>
      call(scope, svc, 'findings', [explorationId]) as Promise<readonly Record<string, unknown>[]>,
    patchFinding: (input) => call(scope, svc, 'patchFinding', [input]) as Promise<Record<string, unknown>>,
    goals: (explorationId) =>
      call(scope, svc, 'goals', [explorationId]) as Promise<readonly Record<string, unknown>[]>,
    addGoal: (input) => call(scope, svc, 'addGoal', [input]) as Promise<Record<string, unknown>>,
    editGoal: (input) => call(scope, svc, 'editGoal', [input]) as Promise<Record<string, unknown>>,
    deleteGoal: (input) => call(scope, svc, 'deleteGoal', [input]) as Promise<Record<string, unknown>>,
    constraints: (explorationId) =>
      call(scope, svc, 'constraints', [explorationId]) as Promise<Record<string, unknown>>,
    setConstraints: (input) => call(scope, svc, 'setConstraints', [input]) as Promise<Record<string, unknown>>,
    scope: (explorationId) => call(scope, svc, 'scope', [explorationId]) as Promise<Record<string, unknown>>,
    addScope: (input) => call(scope, svc, 'addScope', [input]) as Promise<Record<string, unknown>>,
    deleteScope: (input) => call(scope, svc, 'deleteScope', [input]) as Promise<Record<string, unknown>>,
    credentials: (explorationId) =>
      call(scope, svc, 'credentials', [explorationId]) as Promise<readonly Record<string, unknown>[]>,
    saveCredential: (input) => call(scope, svc, 'saveCredential', [input]) as Promise<Record<string, unknown>>,
    deleteCredential: (input) => call(scope, svc, 'deleteCredential', [input]) as Promise<Record<string, unknown>>,
    coverage: (explorationId) => call(scope, svc, 'coverage', [explorationId]) as Promise<Record<string, unknown>>,
    untestedAssets: (input) =>
      call(scope, svc, 'untestedAssets', input === undefined ? [] : [input]) as Promise<Record<string, unknown>>,
    intentControl: (input) => call(scope, svc, 'intentControl', [input]) as Promise<Record<string, unknown>>,
    trafficHosts: () => call(scope, svc, 'trafficHosts', []) as Promise<readonly Record<string, unknown>[]>,
    trafficSearch: (query) => call(scope, svc, 'trafficSearch', [query]) as Promise<readonly Record<string, unknown>[]>,
    trafficExchange: (trafficId) =>
      call(scope, svc, 'trafficExchange', [trafficId]) as Promise<Record<string, unknown> | undefined>,
    trafficBlob: (input) =>
      call(scope, svc, 'trafficBlob', [input.hash, input.offset, input.length]) as Promise<
        { dataBase64: string; total: number } | undefined
      >,
    ingestTraffic: (input) => call(scope, svc, 'ingestTraffic', [input]) as Promise<Record<string, unknown>>,
    targetPins: (input) =>
      call(scope, svc, 'targetPins', input === undefined ? [] : [input]) as Promise<readonly Record<string, unknown>[]>,
    revokeTargetPin: (input) => call(scope, svc, 'revokeTargetPin', [input]) as Promise<Record<string, unknown>>,
    exportReport: (input) => call(scope, svc, 'exportReport', [input]) as Promise<Record<string, unknown>>,
  };
}