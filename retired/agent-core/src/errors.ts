// Barrel re-export so #/errors resolves to a single .ts file (the first
// entry in the package imports map). vitest does not resolve cleanly through
// the directory fallback; this thin barrel keeps the alias working uniformly
// across node, tsc, and vitest. Real module lives under ./errors.
export * from './errors/index';
