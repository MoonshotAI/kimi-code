/**
 * Compile-time type equality.
 *
 * Used to pin a hand-written type to the zod schema that re-derives it —
 * e.g. kosong's persistence-free types vs the section schemas their
 * `kosongConfig` wrapper registers: a drift in either direction (added /
 * removed field, changed field type, optionality flip) fails typecheck.
 *
 * `Equal` compares by mutual assignability through a contravariant
 * function-type trick, so it is stricter than a one-way `A extends B`
 * check. Both sides are flattened first (a homomorphic mapped type), so a
 * schema-side intersection (e.g. the `{...} & { [k: string]: unknown }`
 * that a passthrough object infers to) compares equal to the equivalent
 * hand-written object type instead of failing on type-node shape. The
 * comparison cannot see `readonly` modifiers (an inherent TS limitation),
 * so hand-written types should match zod's mutable inference exactly.
 */

type Flatten<T> = { [K in keyof T]: T[K] } & {};

export type Equal<A, B> =
  (<T>() => T extends Flatten<A> ? 1 : 2) extends <T>() => T extends Flatten<B> ? 1 : 2
    ? true
    : false;

export type AssertExact<T extends true> = T;
