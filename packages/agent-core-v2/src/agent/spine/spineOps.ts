
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
