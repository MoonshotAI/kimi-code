/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

export interface TokenAnchor {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface TokenCountingState {
  readonly anchors: readonly TokenAnchor[];
  readonly tokens: number;
}

const sizeSchema = z.object({
  agentId: z.string(),
  length: z.number(),
  tokens: z.number(),
});

export class TokenCountingMeasured extends AgentEvent2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.measured';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingMeasured {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

export class TokenCountingTruncated extends AgentEvent2<z.infer<typeof sizeSchema>> {
  static override readonly type = 'token_counting.truncated';
  static override readonly durable = true;
  static override readonly schema = sizeSchema;
}
export interface TokenCountingTruncated {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

const rebaseSchema = sizeSchema.extend({ measured: z.boolean() });

export class TokenCountingRebased extends AgentEvent2<z.infer<typeof rebaseSchema>> {
  static override readonly type = 'token_counting.rebased';
  static override readonly durable = true;
  static override readonly schema = rebaseSchema;
}
export interface TokenCountingRebased {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

const turnRecordedSchema = sizeSchema.extend({ turnId: z.number() });

export class TokenCountingTurnRecorded extends AgentEvent2<z.infer<typeof turnRecordedSchema>> {
  static override readonly type = 'token_counting.turn_recorded';
  static override readonly durable = true;
  static override readonly schema = turnRecordedSchema;
}
export interface TokenCountingTurnRecorded {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly turnId: number;
}

export function anchorsEqual(a: readonly TokenAnchor[], b: readonly TokenAnchor[]): boolean {
  return a.length === b.length && a.every((anchor, i) => anchor === b[i]);
}

export function normalizeAnchorLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}
