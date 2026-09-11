export const SPINE_TRIM_THRESHOLD_BYTES = 10 * 1024;

export type SpineTrimSliceShape =
  | { readonly type: 'head'; readonly chars: number }
  | { readonly type: 'tail'; readonly chars: number }
  | {
      readonly type: 'anchor';
      readonly anchor: string;
      readonly preceding: number;
      readonly following: number;
    };

export type SpineTrimOp =
  | { readonly kind: 'snip' }
  | { readonly kind: 'slice'; readonly shape: SpineTrimSliceShape };

export interface SpineTrimProjection {
  readonly labels: ReadonlyMap<number, string>;
  readonly tagIndex: ReadonlyMap<string, number>;
  readonly masks: ReadonlyMap<number, SpineTrimOp>;
  readonly eligible: ReadonlySet<string>;
  readonly consumed: ReadonlySet<string>;
}

export function normalizeTrimOp(
  op: string,
  shape: {
    readonly head?: number | undefined;
    readonly tail?: number | undefined;
    readonly anchor?: string | undefined;
    readonly preceding?: number | undefined;
    readonly following?: number | undefined;
  },
): SpineTrimOp | undefined {
  if (op === 'snip') return { kind: 'snip' };
  if (op !== 'slice') return undefined;
  const slices: SpineTrimSliceShape[] = [];
  if (shape.head !== undefined) slices.push({ type: 'head', chars: shape.head });
  if (shape.tail !== undefined) slices.push({ type: 'tail', chars: shape.tail });
  if (shape.anchor !== undefined) {
    slices.push({
      type: 'anchor',
      anchor: shape.anchor,
      preceding: shape.preceding ?? 0,
      following: shape.following ?? 0,
    });
  }
  if (slices.length !== 1) return undefined;
  const slice = slices[0];
  if (slice === undefined) return undefined;
  return { kind: 'slice', shape: slice };
}

export interface SpineTrimCallArgs {
  readonly trimId: string;
  readonly op: SpineTrimOp;
}

export function parseSpineTrimCallArgs(
  raw: string | null | undefined,
): SpineTrimCallArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const trimId = record['TRIM_ID'];
  if (typeof trimId !== 'string' || trimId.length === 0) return undefined;
  const op = record['op'];
  if (typeof op !== 'string') return undefined;
  const normalized = normalizeTrimOp(op, {
    head: positiveInt(record['head']),
    tail: positiveInt(record['tail']),
    anchor: nonEmptyString(record['anchor']),
    preceding: nonNegativeInt(record['preceding']),
    following: nonNegativeInt(record['following']),
  });
  if (normalized === undefined) return undefined;
  return { trimId, op: normalized };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
