/**
 * `spine` domain (L4) — the `SpineState` / `SpineNode` types the whole
 * domain shares.
 *
 * The live tree is rebuilt from the `contextMemory` message stream by
 * `spineDerive.deriveSpineState`; the state shape below is the derivation's
 * output contract — a node map, the open-node stack (its top is the cursor),
 * and the current root-epoch boundary, with `openedAt`/`closedAt` indexing
 * the stored history. Consumed by the Agent-scope `spineService` and the
 * `spineFold` projection.
 *
 * Sessions persisted before the derivation rewrite carry legacy `spine.*` op
 * records; the dispatcher's restore skips unknown record types
 * (skip-and-count), so they replay without any registered reducer.
 *
 * `SpineNode.spawn` is an optional evidence field produced only by the
 * derivation for nodes synthesized from a `spine_spawn` receipt.
 */

export interface SpineSpawnEvidence {
  readonly summary: string;
  readonly outcome: 'completed' | 'errored' | 'aborted';
  readonly diagnostic?: string;
}

export interface SpineNode {
  readonly id: string;
  readonly summary: string;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly memory?: string;
  readonly archivePath?: string;
  readonly baselineTokens?: number;
  readonly finalTokens?: number;
  readonly spawn?: SpineSpawnEvidence;
  readonly children: readonly string[];
}

export interface SpineState {
  readonly nodes: Readonly<Record<string, SpineNode>>;
  readonly openStack: readonly string[];
  readonly rootEpoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt?: number;
}
