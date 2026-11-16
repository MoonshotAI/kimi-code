import { createUserMessage } from '@moonshot-ai/core/llm/message';

import { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  ARTEX_COMPACTOR_DATA_RULE,
  ARTEX_UNTRUSTED_DATA_RULES,
} from '#/features/artex/prompts/index';
import {
  blockSignature,
  ColdGraph,
  computeColdStampOps,
  DEFAULT_COLD_PARAMS,
  type ColdBlock,
  type ColdGraphEdge,
  type ColdGraphNode,
  type ColdParams,
} from '#/features/artex/logic/coldgraph';
import type { ArtexNode } from '#/features/artex/protocol/index';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';

const COMPRESSION_SYSTEM_PROMPT =
  `You are compressing a group of [interconnected] exploration nodes into one consolidated conclusion (body), so the planner can quickly grasp "what this area has already established".

The input is a connected sub-graph:
- Nodes: each line is the summary (one sentence) of an intent or a fact, with id, kind (intent/fact), state, and confidence (if any).
- Relations: lineage edges between nodes (A derived from B / A yields B), explaining how they chain together.
- If nodes share no direct lineage edge but belong to the same upstream intent (given separately as "common parent #p"), consolidate them as "what this intent (#p) explored" — common parents are only context anchors, not members to compress.

Write the body accordingly:
1. Synthesize, don't enumerate: follow the relations to chain the causality (which fact spawned which intent, which intent produced which conclusion), telling "what this area of exploration concluded" — do not copy each summary verbatim.
2. Preserve distinctions: state differing conclusions separately; don't blend them into one vague sentence.
3. Preserve evidence strength: mark conclusions carrying confidence as observed / inferred; for inferred negative/doubtful conclusions, point out they are only inferences and can be rechecked — don't write them as settled facts.
4. Include ids: annotate each conclusion with its source node ids (e.g. "…(#12,#28)"), so the planner can restore the original nodes by id.
5. State positively, write only what the input contains: no speculation, no judgments absent from the input.
6. Length adapts to content: short when there are few conclusions, long enough when there are many distinct ones — but overall significantly shorter than the sum of all input summaries.

Output only the body text itself.\n\n` +
  `${ARTEX_UNTRUSTED_DATA_RULES}\n${ARTEX_COMPACTOR_DATA_RULE}`;

export type ArtexCompactorCompressFn = (
  input: string,
  systemPrompt: string,
  signal: AbortSignal,
) => Promise<string>;

export interface ArtexCompactorOptions {
  readonly params?: ColdParams;
  readonly minorThreshold?: number;
  readonly majorThreshold?: number;
  readonly cooldownMs?: number;
  readonly maxDurationMs?: number;
}

export interface ArtexMaintainResult {
  readonly round: number;
  readonly uncompressed: number;
  readonly activeDigests: number;
}

export function createLoopCompactorCompress(
  caller: IAgentScopeHandle | undefined,
): ArtexCompactorCompressFn | undefined {
  if (caller === undefined) return undefined;
  const loop = caller.accessor.get(IAgentLoopService);
  if (loop === undefined) return undefined;
  return async (input, systemPrompt, signal) => {
    const requester = await loop.requester.prepareOperation(
      {
        source: () => ({ type: 'operation', requestKind: 'artex_compaction' }),
        tools: [],
      },
      signal,
    );
    const outcome = await requester.generate(
      {
        content: { messages: [createUserMessage(input)] },
        profile: { systemPrompt },
      },
      { signal },
    );
    if (outcome.type !== 'done') return '';
    return outcome.message.content
      .filter((part): part is Extract<(typeof outcome.message.content)[number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
  };
}

export class ArtexCompactor {
  readonly params: ColdParams;
  readonly minorThreshold: number;
  readonly majorThreshold: number;
  readonly cooldownMs: number;
  readonly maxDurationMs: number;
  private readonly running = new Set<number>();
  private readonly lastRun = new Map<number, number>();
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(options: ArtexCompactorOptions = {}) {
    this.params = options.params ?? DEFAULT_COLD_PARAMS;
    this.minorThreshold = options.minorThreshold ?? 20;
    this.majorThreshold = options.majorThreshold ?? 8;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxDurationMs = options.maxDurationMs ?? 5 * 60_000;
  }

  async maintain(store: IArtexGraphStore): Promise<ArtexMaintainResult> {
    const round = await store.bumpRound();
    const [{ graph }, stamps, covered, active] = await Promise.all([
      loadColdGraph(store),
      store.coldStamps(),
      store.coveredMembers(),
      store.activeDigests(),
    ]);
    const hot = graph.hotSet();
    const structCold = graph.structuralCold(hot);
    const ops = computeColdStampOps(structCold, stamps, round);
    await store.applyColdStamps(ops);
    for (const op of ops) {
      if (op.set) stamps.set(op.id, op.round);
      else stamps.delete(op.id);
    }
    const elig = graph.eligibleCold(structCold, stamps, round, this.params);
    let uncompressed = 0;
    for (const id of elig) {
      if (!covered.has(id)) uncompressed += 1;
    }
    return {
      round,
      uncompressed,
      activeDigests: active.length,
    };
  }

  async onPlannerRound(
    store: IArtexGraphStore,
    compress?: ArtexCompactorCompressFn,
    signal?: AbortSignal,
  ): Promise<ArtexMaintainResult> {
    const maintained = await this.maintain(store);
    if (compress === undefined) return maintained;
    const needMajor = maintained.activeDigests >= this.majorThreshold;
    const needMinor = maintained.uncompressed >= this.minorThreshold;
    if (!needMinor && !needMajor) return maintained;
    if (!this.tryStart(store.explorationId)) return maintained;

    const task = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error('compaction timeout'));
      }, this.maxDurationMs);
      timeout.unref?.();
      const onParentAbort = (): void => {
        controller.abort(signal?.reason);
      };
      signal?.addEventListener('abort', onParentAbort, { once: true });
      try {
        if (needMajor) {
          await this.major(store, compress, controller.signal);
        } else {
          await this.minor(store, compress, controller.signal);
        }
      } catch {
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onParentAbort);
        this.finish(store.explorationId);
      }
    })();
    this.activeTasks.add(task);
    void task.finally(() => {
      this.activeTasks.delete(task);
    });
    return maintained;
  }

  async drain(): Promise<void> {
    if (this.activeTasks.size === 0) return;
    await Promise.allSettled(this.activeTasks);
  }

  async minor(
    store: IArtexGraphStore,
    compress: ArtexCompactorCompressFn,
    signal: AbortSignal,
  ): Promise<number> {
    const [round, { graph, nodeById }, stamps, cvers, covered] = await Promise.all([
      store.roundNo(),
      loadColdGraph(store),
      store.coldStamps(),
      store.contentVersions(),
      store.coveredMembers(),
    ]);
    const hot = graph.hotSet();
    const elig = graph.eligibleCold(graph.structuralCold(hot), stamps, round, this.params);
    const uncompressed = new Set<number>();
    for (const id of elig) {
      if (!covered.has(id)) uncompressed.add(id);
    }
    const blocks = graph.group(uncompressed, this.params);
    let created = 0;
    for (const block of blocks) {
      if (signal.aborted) break;
      const digestId = await this.foldBlock(store, graph, block, nodeById, cvers, generationFor(block, []), compress, signal);
      if (digestId !== undefined) created += 1;
    }
    const active = await store.activeDigests();
    if (active.length >= this.majorThreshold && !signal.aborted) {
      await this.major(store, compress, signal);
    }
    return created;
  }

  async major(
    store: IArtexGraphStore,
    compress: ArtexCompactorCompressFn,
    signal: AbortSignal,
  ): Promise<number> {
    const [round, { graph, nodeById }, stamps, cvers, active] = await Promise.all([
      store.roundNo(),
      loadColdGraph(store),
      store.coldStamps(),
      store.contentVersions(),
      store.activeDigests(),
    ]);
    const hot = graph.hotSet();
    const elig = graph.eligibleCold(graph.structuralCold(hot), stamps, round, this.params);
    const blocks = graph.group(elig, this.params);

    const bySig = new Map<string, ArtexNode>();
    for (const digest of active) {
      const { signature } = digestSigGen(digest);
      if (signature !== '') bySig.set(signature, digest);
    }
    const desired = new Set<string>();
    const toCreate: ColdBlock[] = [];
    for (const block of blocks) {
      const sig = blockSignature(block, cvers);
      desired.add(sig);
      if (!bySig.has(sig)) toCreate.push(block);
    }
    const staleIds: number[] = [];
    for (const digest of active) {
      const { signature } = digestSigGen(digest);
      if (!desired.has(signature)) staleIds.push(digest.id);
    }
    await store.supersedeDigests(staleIds);

    let created = 0;
    for (const block of toCreate) {
      if (signal.aborted) break;
      const digestId = await this.foldBlock(
        store,
        graph,
        block,
        nodeById,
        cvers,
        generationFor(block, active),
        compress,
        signal,
      );
      if (digestId !== undefined) created += 1;
    }
    return created;
  }

  private async foldBlock(
    store: IArtexGraphStore,
    graph: ColdGraph,
    block: ColdBlock,
    nodeById: ReadonlyMap<number, ArtexNode>,
    cvers: ReadonlyMap<number, number>,
    generation: number,
    compress: ArtexCompactorCompressFn,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const input = buildCompressionInput(graph, block, nodeById, await store.edges());
    const body = (await compress(input, COMPRESSION_SYSTEM_PROMPT, signal)).trim();
    if (body.length === 0) return undefined;

    const fresh = await loadColdGraph(store);
    const freshHot = fresh.graph.hotSet();
    const liveMembers = block.members.filter((id) => !freshHot.has(id));
    if (liveMembers.length < this.params.k) return undefined;

    const finalBlock: ColdBlock = { members: liveMembers, anchors: block.anchors };
    const payload = buildDigestPayload(
      body,
      finalBlock,
      nodeById,
      generation,
      blockSignature(finalBlock, cvers),
    );
    return store.addDigest(payload, liveMembers);
  }

  private tryStart(explorationId: number): boolean {
    if (this.running.has(explorationId)) return false;
    const last = this.lastRun.get(explorationId);
    if (last !== undefined && Date.now() - last < this.cooldownMs) return false;
    this.running.add(explorationId);
    return true;
  }

  private finish(explorationId: number): void {
    this.running.delete(explorationId);
    this.lastRun.set(explorationId, Date.now());
  }
}

export async function loadColdGraph(store: IArtexGraphStore): Promise<{
  readonly graph: ColdGraph;
  readonly nodeById: Map<number, ArtexNode>;
}> {
  const [nodes, edges] = await Promise.all([store.nodes(), store.edges()]);
  const cgNodes: ColdGraphNode[] = [];
  const nodeById = new Map<number, ArtexNode>();
  for (const node of nodes) {
    cgNodes.push({ id: node.id, kind: node.kind, state: node.state });
    nodeById.set(node.id, node);
  }
  const cgEdges: ColdGraphEdge[] = edges.map((edge) => ({
    from: edge.srcId,
    rel: edge.rel,
    to: edge.dstId,
  }));
  return { graph: new ColdGraph(cgNodes, cgEdges), nodeById };
}

function generationFor(block: ColdBlock, active: readonly ArtexNode[]): number {
  if (active.length === 0) return 1;
  const memberSet = new Set(block.members);
  let best = 0;
  for (const digest of active) {
    const { generation } = digestSigGen(digest);
    const members = digestMemberIds(digest);
    if (members.some((id) => memberSet.has(id)) && generation > best) {
      best = generation;
    }
  }
  return best + 1;
}

function digestSigGen(node: ArtexNode): { readonly signature: string; readonly generation: number } {
  const payload = node.payload as { signature?: unknown; generation?: unknown };
  return {
    signature: typeof payload.signature === 'string' ? payload.signature : '',
    generation: typeof payload.generation === 'number' ? payload.generation : 0,
  };
}

function digestMemberIds(node: ArtexNode): number[] {
  const memberIds = (node.payload as { member_ids?: { facts?: unknown; intents?: unknown } })
    .member_ids;
  if (!memberIds) return [];
  const facts = Array.isArray(memberIds.facts)
    ? memberIds.facts.filter((id): id is number => typeof id === 'number')
    : [];
  const intents = Array.isArray(memberIds.intents)
    ? memberIds.intents.filter((id): id is number => typeof id === 'number')
    : [];
  return [...facts, ...intents];
}

function buildDigestPayload(
  body: string,
  block: ColdBlock,
  nodeById: ReadonlyMap<number, ArtexNode>,
  generation: number,
  signature: string,
): Record<string, unknown> {
  const facts: number[] = [];
  const intents: number[] = [];
  for (const id of block.members) {
    const node = nodeById.get(id);
    if (node?.kind === 'intent') intents.push(id);
    else facts.push(id);
  }
  return {
    body,
    member_ids: { facts, intents },
    anchor_ids: [...block.anchors],
    generation,
    signature,
  };
}

function nodeSummary(node: ArtexNode | undefined): string {
  if (!node) return '';
  const payload = node.payload as { summary?: unknown; text?: unknown };
  if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text.trim();
  }
  return '';
}

function buildCompressionInput(
  _graph: ColdGraph,
  block: ColdBlock,
  nodeById: ReadonlyMap<number, ArtexNode>,
  edges: readonly { readonly srcId: number; readonly rel: string; readonly dstId: number }[],
): string {
  const memberSet = new Set(block.members);
  const lines: string[] = ['[Member nodes (to be compressed)]:'];
  for (const id of block.members) {
    const node = nodeById.get(id);
    const kind = node?.kind === 'intent' ? 'intent' : 'fact';
    const state = node?.state ?? '';
    const payload = (node?.payload ?? {}) as { confidence?: unknown; source?: unknown };
    const attrs: string[] = [];
    if (typeof payload.confidence === 'string' && payload.confidence !== '') {
      attrs.push(`confidence=${payload.confidence}`);
    }
    if (typeof payload.source === 'string' && payload.source !== '') {
      attrs.push(`source=${payload.source}`);
    }
    if (node?.origin) {
      attrs.push(`origin=${node.origin}`);
    }
    const suffix = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
    lines.push(`- #${String(id)} [${kind}/${state}] ${nodeSummary(node)}${suffix}`);
  }
  const edgeLines: string[] = [];
  for (const edge of edges) {
    if (edge.rel !== 'covers' && memberSet.has(edge.srcId) && memberSet.has(edge.dstId)) {
      edgeLines.push(`- #${String(edge.srcId)} yields/derives→ #${String(edge.dstId)}`);
    }
  }
  if (edgeLines.length > 0) {
    lines.push('', '[Lineage edges between members (parent→child)]:', ...edgeLines.toSorted());
  }
  if (block.anchors.length > 0) {
    lines.push(
      '',
      '[Common parents / context anchors (not members; only used to understand which intent these results were explored from)]:',
    );
    for (const anchorId of block.anchors) {
      const anchor = nodeById.get(anchorId);
      lines.push(`- #${String(anchorId)} [${anchor?.state ?? ''}] ${nodeSummary(anchor)}`);
    }
  }
  return lines.join('\n');
}
