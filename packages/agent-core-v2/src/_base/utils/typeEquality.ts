type Flatten<T> = { [K in keyof T]: T[K] } & {};

export type Equal<A, B> =
  (<T>() => T extends Flatten<A> ? 1 : 2) extends <T>() => T extends Flatten<B> ? 1 : 2
    ? true
    : false;

export type AssertExact<T extends true> = T;
