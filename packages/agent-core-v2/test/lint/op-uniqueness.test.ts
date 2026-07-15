import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineModel } from '#/wire/model';
import { DuplicateOpError, OP_REGISTRY } from '#/wire/op';
import type { OpPayload } from '#/wire/types';

declare module '#/wire/types' {
  interface PersistedOpMap {
    'test.op.persisted': typeof persistedOp;
    'test.op.conflicting': typeof persistedOp;
  }

  interface TransientOpMap {
    'test.op.transient': typeof transientOp;
    'test.op.conflicting': typeof persistedOp;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(PKG_ROOT, 'src');
const FIXTURE_ROOT = join(__dirname, 'fixtures');

const DEFINE_OP_RE = /\.defineOp\s*\(\s*['"]([^'"]+)['"]/g;

const testModel = defineModel('typecheck.model', () => ({ value: 0 }));

const persistedOp = testModel.defineOp('test.op.persisted', {
  schema: z.object({ value: z.number() }),
  apply: (state, payload: { value: number }) => ({ value: state.value + payload.value }),
});

const transientOp = testModel.defineOp('test.op.transient', {
  schema: z.object({ value: z.number() }),
  persist: false,
  apply: (_state, payload) => ({ value: payload.value }),
});

function typecheckRegisteredOps(): void {
  type RegisteredPayload = OpPayload<'test.op.persisted'>;
  const registeredPayload: RegisteredPayload = { value: 1 };
  persistedOp(registeredPayload);
  // @ts-expect-error Op factories carry the payload from their own definition
  persistedOp({ value: '1' });
  // @ts-expect-error transient Op factories carry the payload from their own definition
  transientOp({ value: '1' });

  const unregistered = testModel.defineOp('test.op.unregistered', {
    schema: z.object({ by: z.number() }),
    persist: false,
    apply: (state, payload) => ({
      value: state.value + payload.by,
    }),
    toEvent: (payload) => ({ by: payload.by }),
  });
  unregistered({ by: 1 });
  // @ts-expect-error unregistered Op factories retain their inferred payload
  unregistered({ by: '1' });

  const wrongPayloadSchema = z.object({ value: z.string() });
  testModel.defineOp('test.op.unregistered', {
    // @ts-expect-error schemas must produce the Op's payload type
    schema: wrongPayloadSchema,
    apply: (state, payload: { value: number }) => ({ value: state.value + payload.value }),
  });

  const incorrectlyTransient = {
    schema: z.object({ value: z.number() }),
    persist: false as const,
    apply: (state: { value: number }, payload: { value: number }) => ({
      value: state.value + payload.value,
    }),
  };
  // @ts-expect-error persisted Op types cannot opt out of persistence
  testModel.defineOp('test.op.persisted', incorrectlyTransient);

  const missingTransientMarker = {
    schema: z.object({ value: z.number() }),
    apply: (state: { value: number }, payload: { value: number }) => ({
      value: state.value + payload.value,
    }),
  };
  // @ts-expect-error transient Op types require persist: false
  testModel.defineOp('test.op.transient', missingTransientMarker);

  const incorrectlyPersistedTransient = {
    schema: z.object({}),
    persist: true as const,
    apply: (state: { value: number }) => state,
  };
  // @ts-expect-error transient Op types cannot opt into persistence
  testModel.defineOp('test.op.transient', incorrectlyPersistedTransient);

  // @ts-expect-error the same Op type cannot belong to both registries
  testModel.defineOp('test.op.conflicting', {
    schema: z.object({ value: z.number() }),
    apply: (_state: { value: number }, payload: { value: number }) => ({
      value: payload.value,
    }),
  });

  const dynamicType: string = 'test.op.persisted';
  // @ts-expect-error Op definitions require a literal type so registry constraints cannot be bypassed
  testModel.defineOp(dynamicType, { schema: z.object({}), apply: (state) => state });

  const unionType = 'test.op.persisted' as 'test.op.persisted' | 'test.op.unregistered';
  // @ts-expect-error Op definitions reject unions that could mix registered and legacy types
  testModel.defineOp(unionType, { schema: z.object({}), apply: (state) => state });

  const templateType = 'test.op.persisted' as `test.op.${string}`;
  // @ts-expect-error Op definitions reject non-literal template string types
  testModel.defineOp(templateType, {
    schema: z.object({}),
    apply: (state: { value: number }) => state,
  });

  const brandedType = 'test.op.persisted' as string & { readonly opType: unique symbol };
  // @ts-expect-error Op definitions reject branded strings that could hide a registered type
  testModel.defineOp(brandedType, {
    schema: z.object({}),
    apply: (state: { value: number }) => state,
  });
}

void typecheckRegisteredOps;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (abs.endsWith('.ts') && !abs.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function scanDefineOpTypes(dir: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8');
    DEFINE_OP_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEFINE_OP_RE.exec(source)) !== null) {
      const type = match[1]!;
      const files = seen.get(type) ?? [];
      files.push(file);
      seen.set(type, files);
    }
  }
  return seen;
}

function duplicates(seen: Map<string, string[]>): Map<string, string[]> {
  const dupes = new Map<string, string[]>();
  for (const [type, files] of seen) {
    if (files.length > 1) dupes.set(type, files);
  }
  return dupes;
}

describe('op-uniqueness', () => {
  it('defineOp throws DuplicateOpError when a type is registered twice', () => {
    const model = defineModel('lint.model', () => ({}));
    try {
      model.defineOp('lint.duplicate.runtime', { schema: z.object({}), apply: (s) => s });
      expect(() =>
        model.defineOp('lint.duplicate.runtime', { schema: z.object({}), apply: (s) => s }),
      ).toThrow(DuplicateOpError);
    } finally {
      OP_REGISTRY.delete('lint.duplicate.runtime');
    }
  });

  it('finds no duplicate defineOp types across src/', () => {
    const seen = scanDefineOpTypes(SRC_ROOT);
    expect(duplicates(seen)).toEqual(new Map());
  });

  it('flags the planted duplicate in the fixture', () => {
    const seen = scanDefineOpTypes(FIXTURE_ROOT);
    const dupes = duplicates(seen);
    expect(dupes.has('fixture.planted')).toBe(true);
    expect(dupes.get('fixture.planted')).toHaveLength(2);
  });
});
