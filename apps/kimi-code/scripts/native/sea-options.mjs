// Runtime options baked into the single-executable binary (see 02-sea-blob.mjs).

// Node flags applied when the binary starts (`process.execArgv` at runtime).
// V8 sizes the young generation from the machine's physical memory, which on
// developer machines means a 64 MB semi-space and roughly 100 MB of resident
// memory that `kimi` never needs; 16 MB keeps scavenges cheap for the CLI's
// allocation pattern while dropping that overhead. Users can still extend the
// flags with NODE_OPTIONS (the default `execArgvExtension: "env"`).
export const SEA_EXEC_ARGV = Object.freeze(['--max-semi-space-size=16']);

// The V8 code cache generated at build time only loads on the platform and
// architecture it was compiled on, so cross-target bundles (a
// KIMI_CODE_BUILD_TARGET that differs from the build host) must leave it out.
export function seaCodeCacheEnabled(target, host = `${process.platform}-${process.arch}`) {
  return target === host;
}
