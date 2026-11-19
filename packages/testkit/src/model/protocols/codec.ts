import { TestkitError } from '#/errors';
import type { ErrorSpec, ProtocolName, ReplyStep, RequestView, ToolCallSpec } from '#/model/types';

export interface ResolvedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface EncodeContext {
  readonly responseId: string;
  readonly model: string;
  readonly usage: ResolvedUsage | null;
  callId(callIndex: number, call: ToolCallSpec): string;
}

export interface StreamSegment {
  readonly unit: number;
  readonly data: string;
}

export interface StreamEncoding {
  readonly headers: Readonly<Record<string, string>>;
  readonly segments: readonly StreamSegment[];
  readonly trailer: readonly string[];
}

export interface EncodedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProtocolCodec {
  readonly name: ProtocolName;
  matches(path: string): boolean;
  parseRequest(body: unknown, path: string): RequestView;
  encodeStream(step: ReplyStep, context: EncodeContext): StreamEncoding;
  encodeStreamError(error: ErrorSpec): string;
  encodeJson(step: ReplyStep, context: EncodeContext): EncodedResponse;
  encodeError(error: ErrorSpec): EncodedResponse;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
};

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function jsonResponse(status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): EncodedResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) };
}

export function objectArguments(call: ToolCallSpec, protocol: ProtocolName): Readonly<Record<string, unknown>> {
  if (call.rawArguments === undefined) return call.args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.rawArguments);
  } catch (error) {
    throw new TestkitError(
      `This ${protocol} response carries tool arguments as a JSON object, so call ${JSON.stringify(call.name)} cannot send raw arguments that do not parse`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TestkitError(`This ${protocol} response carries tool arguments as a JSON object, so call ${JSON.stringify(call.name)} needs raw arguments that are one`);
  }
  return parsed as Record<string, unknown>;
}
