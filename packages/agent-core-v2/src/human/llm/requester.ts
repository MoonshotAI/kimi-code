import { runLlmRequest, type LlmRunControl } from '#/llm/policy/policy';
import type { LlmOutcome } from '#/llm/response';
import type { LlmRequest } from '#/llm/request';

export type LlmDimension = keyof LlmRequest;

type RequiredDimension = 'protocol' | 'model' | 'content';

type DimensionOf<K extends LlmDimension> = NonNullable<LlmRequest[K]>;

export type LlmRequestPart = {
  readonly [K in LlmDimension]?: Partial<DimensionOf<K>>;
};

export type LlmRequestFill<F extends LlmDimension> = {
  readonly [K in Exclude<LlmDimension, F>]?: DimensionOf<K>;
} & {
  readonly [K in F]?: Partial<DimensionOf<K>>;
};

export type LlmRequestRest<F extends LlmDimension> = LlmRequestFill<F> & {
  readonly [K in Exclude<RequiredDimension, F>]-?: DimensionOf<K>;
};

export const requesterContents: unique symbol = Symbol('llm.requester.contents');

export interface LlmRequester<F extends LlmDimension = never> {
  readonly [requesterContents]?: LlmRequestPart;
  with<G extends LlmDimension>(other: LlmRequester<G>): LlmRequester<F | G>;
  with<P extends LlmRequestFill<F>>(part: P): LlmRequester<F | Extract<keyof P, LlmDimension>>;
  request(rest: LlmRequestRest<F>): LlmRequest;
  generate(rest: LlmRequestRest<F>, control: LlmRunControl): Promise<LlmOutcome>;
}

type Fields = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function mergeFields(prev: Fields | undefined, next: Fields | undefined): Fields | undefined {
  if (prev === undefined) return next;
  if (next === undefined) return prev;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prev)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const prevValue = merged[key];
    merged[key] =
      isPlainObject(prevValue) && isPlainObject(value)
        ? mergeFields(prevValue, value)
        : value;
  }
  return merged;
}

function mergeRequest(base: LlmRequestPart, part: LlmRequestPart): LlmRequestPart {
  return mergeFields(base as Fields, part as Fields) as LlmRequestPart;
}

export function contentsOf(part: LlmRequestPart | LlmRequester<LlmDimension>): LlmRequestPart {
  if (typeof (part as LlmRequester).with !== 'function') return part as LlmRequestPart;
  const contents = (part as LlmRequester)[requesterContents];
  if (contents === undefined) throw new TypeError('requester does not expose its contents');
  return contents;
}

function partialRequester<F extends LlmDimension>(filled: LlmRequestPart): LlmRequester<F> {
  const complete = (rest: LlmRequestPart) => mergeRequest(filled, rest) as LlmRequest;
  return {
    [requesterContents]: filled,
    with: ((part: LlmRequestPart | LlmRequester<LlmDimension>) =>
      partialRequester(mergeRequest(filled, contentsOf(part)))) as LlmRequester<F>['with'],
    request: complete,
    generate: (rest, control) => runLlmRequest(complete(rest), control),
  };
}

export function createRequester(): LlmRequester {
  return partialRequester({});
}
