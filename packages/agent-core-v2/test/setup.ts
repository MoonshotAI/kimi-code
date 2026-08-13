/**
 * Hermetic experimental-flag state for tests: scrub ambient
 * `KIMI_CODE_EXPERIMENTAL_*` env vars inherited from the developer shell
 * (e.g. a globally exported `KIMI_CODE_EXPERIMENTAL_FLAG=1`) so flag-driven
 * behavior — including tool schemas embedded in `llm.tools_snapshot`
 * snapshots — stays deterministic and matches CI. Tests opt into flags
 * explicitly via service overrides or `vi.stubEnv`.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

// `persistence_minidb_readmodel` defaults ON in production, but the shared
// harness boots full containers against a fixed homeDir — with the read
// model engaged, every container opens the same query-store minidb (teardown
// races, mirror flush timers under fake timers). Pin the legacy path here;
// read-model suites opt in with explicit flag service overrides
// (test/app/sessionIndex).
process.env['KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL'] = 'false';
