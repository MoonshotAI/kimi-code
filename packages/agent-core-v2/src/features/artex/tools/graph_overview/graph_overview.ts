import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { loadColdGraph } from '#/features/artex/engine/compactor';
import { detectStagnation } from '#/features/artex/logic/stagnation';
import type {
  ArtexIntentNode,
  ArtexIntentState,
  ArtexNode,
} from '#/features/artex/protocol/index';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './graph_overview.md?raw';

export const GraphOverviewInputSchema = z.object({});

export type GraphOverviewInput = z.infer<typeof GraphOverviewInputSchema>;

const PARAMETERS = toInputJsonSchema(GraphOverviewInputSchema);

export const IArtexGraphOverviewTool: ServiceIdentifier<AgentTool<GraphOverviewInput>> =
  createDecorator<AgentTool<GraphOverviewInput>>('artexGraphOverviewTool');

const OPEN_INTENTS_CAP = 30;
const RECENT_DONE_CAP = 12;
const FINDING_LIST_CAP = 10;
const RECENT_FACTS_CAP = 20;
const COLD_DIGESTS_CAP = 15;
const FACT_SUMMARY_MAX = 160;

function nodeSummary(node: ArtexNode): string {
  const payload = node.payload as { summary?: unknown; text?: unknown };
  if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text.trim();
  }
  return '';
}

function clipSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pushToMap(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function compactIntent(
  node: ArtexIntentNode,
  parentsOf: ReadonlyMap<number, readonly number[]>,
  yieldsOf: ReadonlyMap<number, readonly number[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    state: node.state,
    priority: node.priority,
    summary: nodeSummary(node),
  };
  const parents = parentsOf.get(node.id);
  if (parents !== undefined && parents.length > 0) out['parents'] = parents;
  const yields = yieldsOf.get(node.id);
  if (yields !== undefined && yields.length > 0) out['yields'] = yields;
  return out;
}

export class ArtexGraphOverviewTool implements AgentTool<GraphOverviewInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'graph_overview' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexWorkStoreProvider private readonly workProvider?: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(_args: GraphOverviewInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Reading the ARTEX graph overview',
      execute: () => this.execute(),
    };
  }

  private async execute(): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store, explorationId } = handle;
    const [stats, nodes, edges, root, frontier, activeDigests, coveredMap, coldData] =
      await Promise.all([
        store.stats(),
        store.nodes(),
        store.edges(),
        store.root(),
        store.frontier(OPEN_INTENTS_CAP),
        store.activeDigests(),
        store.coveredMemberMap(),
        loadColdGraph(store),
      ]);

    const hotAtRender = coldData.graph.hotSet();
    const isHidden = (id: number): boolean => coveredMap.has(id) && !hotAtRender.has(id);

    const parentsOf = new Map<number, number[]>();
    const yieldsOf = new Map<number, number[]>();
    const factFrom = new Map<number, number>();
    for (const edge of edges) {
      if (edge.rel === 'derived_from' || edge.rel === 'spawns') {
        pushToMap(parentsOf, edge.dstId, edge.srcId);
      } else if (edge.rel === 'yields') {
        pushToMap(yieldsOf, edge.srcId, edge.dstId);
        factFrom.set(edge.dstId, edge.srcId);
      }
    }

    const intentCounts: Record<ArtexIntentState, number> = {
      open: 0,
      running: 0,
      paused: 0,
      done: 0,
      blocked: 0,
      exhausted: 0,
      stopped: 0,
      deleted: 0,
    };

    const goalNodes: ArtexNode[] = [];
    const hintNodes: ArtexNode[] = [];
    const runningIntents: ArtexIntentNode[] = [];
    const recentDoneIntents: ArtexIntentNode[] = [];
    const allDoneForStagnation: { readonly id: number; readonly summary: string }[] = [];
    const findingNodes: ArtexNode[] = [];
    const factNodes: ArtexNode[] = [];
    let doneIntentsTotal = 0;

    for (const node of nodes) {
      switch (node.kind) {
        case 'goal':
          goalNodes.push(node);
          break;
        case 'hint':
          hintNodes.push(node);
          break;
        case 'intent':
          intentCounts[node.state] += 1;
          if (node.state === 'running') {
            runningIntents.push(node);
          } else if (
            node.state === 'done' ||
            node.state === 'blocked' ||
            node.state === 'exhausted'
          ) {
            doneIntentsTotal += 1;
            allDoneForStagnation.push({ id: node.id, summary: nodeSummary(node) });
            if (!isHidden(node.id)) {
              recentDoneIntents.push(node);
            }
          }
          break;
        case 'finding':
          findingNodes.push(node);
          break;
        case 'fact':
          factNodes.push(node);
          break;
        case 'begin':
        case 'digest':
          break;
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    }

    const goals = goalNodes.map((node) => ({
      id: node.id,
      state: node.state,
      summary: nodeSummary(node),
    }));

    const hints = hintNodes
      .slice(-50)
      .toReversed()
      .map((node) => ({
        id: node.id,
        state: node.state,
        text: nodeSummary(node),
        origin: node.origin,
      }));

    const findingSorted = findingNodes.toSorted((a, b) => b.id - a.id);
    const findingList = findingSorted.slice(0, FINDING_LIST_CAP).map((node) => ({
      id: node.id,
      summary: nodeSummary(node),
      from_intent: factFrom.get(node.id),
    }));

    const recentDoneSorted = recentDoneIntents.toSorted((a, b) => b.id - a.id).slice(0, RECENT_DONE_CAP);
    const stagnation = detectStagnation(
      allDoneForStagnation.toSorted((a, b) => b.id - a.id),
      findingSorted.map((node) => ({ id: node.id })),
    );

    const recentFacts = factNodes
      .toSorted((a, b) => b.id - a.id)
      .filter((node) => !isHidden(node.id))
      .slice(0, RECENT_FACTS_CAP)
      .map((node) => {
        const payload = node.payload as { confidence?: unknown; source?: unknown };
        return {
          id: node.id,
          summary: clipSummary(nodeSummary(node), FACT_SUMMARY_MAX),
          origin: node.origin,
          source: typeof payload.source === 'string' ? payload.source : undefined,
          confidence: typeof payload.confidence === 'string' ? payload.confidence : undefined,
          from_intent: factFrom.get(node.id),
        };
      });

    const digestEntries = await Promise.all(
      activeDigests.map(async (digest) => {
        const members = await store.digestMembers(digest.id);
        const freshness = members.at(-1) ?? 0;
        const body = (digest.payload as { body?: unknown }).body;
        return {
          id: digest.id,
          freshness,
          entry: {
            id: digest.id,
            body: typeof body === 'string' ? body : '',
            member_count: members.length,
          },
        };
      }),
    );
    digestEntries.sort((a, b) => b.freshness - a.freshness);
    const coldDigests = digestEntries.slice(0, COLD_DIGESTS_CAP).map((item) => item.entry);
    const coldDigestsMore = digestEntries.slice(COLD_DIGESTS_CAP).map((item) => item.id);

    const payload: Record<string, unknown> = {
      exploration_id: explorationId,
      goal: root.goal,
      scope: root.description,
      node_counts: stats,
      intents: intentCounts,
      goals,
      hints,
      frontier: frontier.map((node) => compactIntent(node, parentsOf, yieldsOf)),
      open_intents: frontier.map((node) => compactIntent(node, parentsOf, yieldsOf)),
      frontier_open: intentCounts.open,
      running_intents: runningIntents.map((node) => compactIntent(node, parentsOf, yieldsOf)),
      recent_done_intents: recentDoneSorted.map((node) => compactIntent(node, parentsOf, yieldsOf)),
      done_intents_total: doneIntentsTotal,
      findings_total: findingNodes.length,
      finding_list: findingList,
      facts: factNodes.length,
      recent_facts: recentFacts,
    };

    if (stagnation.length > 0) {
      payload['stagnation_warning'] = {
        directions: stagnation,
        instruction:
          'these directions were dispatched repeatedly with zero findings produced since their first attempt — do NOT re-dispatch the same approach again; open a materially different direction, or judge the goal on the existing evidence instead of grinding',
      };
    }
    if (coldDigests.length > 0) {
      payload['cold_digests'] = coldDigests;
      if (coldDigestsMore.length > 0) {
        payload['cold_digests_more'] = coldDigestsMore;
      }
    }

    if (this.workProvider !== undefined) {
      try {
        const workStore = this.workProvider.open(this.session.workspaceRoot);
        await workStore.ensureSeeded();
        const [constraints, credentials] = await Promise.all([
          workStore.listConstraints(explorationId),
          workStore.taskCredentials(explorationId),
        ]);
        if (constraints.length > 0) {
          payload['constraints'] = constraints.map((c) => ({
            id: c.id,
            kind: c.kind,
            text: c.text,
          }));
        }
        if (credentials.length > 0) {
          payload['task_credentials'] = credentials.map((c) => ({
            id: c.id,
            domain: c.domain,
            username: c.username,
            source: c.source,
            note: c.note,
          }));
        }
      } catch {
      }
    }

    return {
      output: artexJson(payload),
    };
  }
}
