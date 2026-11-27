export type UiPreferenceOperation =
  | { readonly op: 'set'; readonly key: string; readonly value: unknown }
  | { readonly op: 'unset'; readonly key: string }
  | { readonly op: 'add'; readonly key: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly key: string; readonly value: unknown }
  | { readonly op: 'set_field'; readonly key: string; readonly field: string; readonly value: unknown }
  | { readonly op: 'unset_field'; readonly key: string; readonly field: string };

export type UiPreferenceOpResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly expected: 'array' | 'object' };

export function isPlainPreferenceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sameUiPreferenceValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function applyUiPreferenceOp(current: unknown, op: UiPreferenceOperation): UiPreferenceOpResult {
  switch (op.op) {
    case 'set':
      return { ok: true, value: op.value };
    case 'unset':
      return { ok: true, value: undefined };
    case 'add':
    case 'remove': {
      if (current !== undefined && !Array.isArray(current)) return { ok: false, expected: 'array' };
      if (current === undefined) return { ok: true, value: op.op === 'add' ? [op.value] : undefined };
      const items: readonly unknown[] = current;
      const present = items.some((item) => sameUiPreferenceValue(item, op.value));
      if (op.op === 'add') return { ok: true, value: present ? items : [...items, op.value] };
      return { ok: true, value: items.filter((item) => !sameUiPreferenceValue(item, op.value)) };
    }
    case 'set_field':
    case 'unset_field': {
      if (current !== undefined && !isPlainPreferenceObject(current)) return { ok: false, expected: 'object' };
      if (op.op === 'set_field') return { ok: true, value: { ...current, [op.field]: op.value } };
      if (current === undefined) return { ok: true, value: undefined };
      const { [op.field]: _removed, ...rest } = current;
      return { ok: true, value: rest };
    }
  }
}
