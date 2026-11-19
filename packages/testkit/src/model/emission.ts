import type { ResolvedUsage } from '#/model/protocols/codec';
import { argumentChunkCount, argumentsText } from '#/model/steps';
import type { ReplyStep, ToolCallSpec } from '#/model/types';

export type Emission =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'think'; readonly text: string; readonly signature?: string }
  | {
      readonly type: 'call-start';
      readonly callIndex: number;
      readonly id: string;
      readonly call: ToolCallSpec;
      readonly arguments: string;
    }
  | {
      readonly type: 'call-arguments';
      readonly callIndex: number;
      readonly id: string;
      readonly call: ToolCallSpec;
      readonly piece: string;
      readonly last: boolean;
    };

interface PendingCall {
  readonly callIndex: number;
  readonly id: string;
  readonly call: ToolCallSpec;
  readonly arguments: string;
  readonly pieces: readonly string[];
}

export function emissionsOf(step: ReplyStep, callId: (callIndex: number, call: ToolCallSpec) => string): Emission[] {
  const emissions: Emission[] = [];
  let nextCallIndex = 0;
  let group: PendingCall[] = [];
  const flush = (): void => {
    emissions.push(...(step.interleaveCalls ? interleaved(group) : sequential(group)));
    group = [];
  };
  for (const part of step.parts) {
    if (part.type === 'call') {
      const callIndex = nextCallIndex;
      nextCallIndex += 1;
      const text = argumentsText(part.call);
      group.push({
        callIndex,
        id: callId(callIndex, part.call),
        call: part.call,
        arguments: text,
        pieces: splitText(text, argumentChunkCount(part.call)),
      });
      continue;
    }
    flush();
    emissions.push(part.type === 'text' ? { type: 'text', text: part.text } : { type: 'think', text: part.text, signature: part.signature });
  }
  flush();
  return emissions;
}

export function resolveUsage(step: ReplyStep, requestBody: string): ResolvedUsage | null {
  if (step.usage === null) return null;
  const estimated: ResolvedUsage = {
    input: estimateTokens(requestBody.length),
    output: estimateTokens(outputLength(step)),
    cacheRead: 0,
    cacheWrite: 0,
  };
  return { ...estimated, ...step.usage };
}

export function splitText(text: string, pieces: number): string[] {
  const characters = Array.from(text);
  const size = Math.ceil(characters.length / pieces);
  return Array.from({ length: pieces }, (_, index) => characters.slice(index * size, (index + 1) * size).join(''));
}

function sequential(calls: readonly PendingCall[]): Emission[] {
  return calls.flatMap((pending) => [startOf(pending), ...piecesOf(pending)]);
}

function interleaved(calls: readonly PendingCall[]): Emission[] {
  const pieces = calls.map(piecesOf);
  const longest = Math.max(0, ...pieces.map((list) => list.length));
  const rounds = Array.from({ length: longest }, (_, round) => pieces.flatMap((list) => list.slice(round, round + 1)));
  return [...calls.map(startOf), ...rounds.flat()];
}

function startOf(pending: PendingCall): Emission {
  return { type: 'call-start', callIndex: pending.callIndex, id: pending.id, call: pending.call, arguments: pending.arguments };
}

function piecesOf(pending: PendingCall): Emission[] {
  return pending.pieces.map((piece, index) => ({
    type: 'call-arguments',
    callIndex: pending.callIndex,
    id: pending.id,
    call: pending.call,
    piece,
    last: index === pending.pieces.length - 1,
  }));
}

function outputLength(step: ReplyStep): number {
  return step.parts.reduce(
    (total, part) => total + (part.type === 'call' ? part.call.name.length + argumentsText(part.call).length : part.text.length),
    0,
  );
}

function estimateTokens(characters: number): number {
  return Math.max(1, Math.ceil(characters / 4));
}
