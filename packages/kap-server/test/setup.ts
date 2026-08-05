/**
 * Vitest setup — hermetic experimental flags.
 *
 * The kap-server suites pin the default (flag-off) behavior of the engine:
 * several scenarios assert wire semantics that an experimental flag
 * deliberately changes (e.g. the minidb session read model makes externally
 * written sessions eventually consistent). A developer shell exporting
 * `KIMI_CODE_EXPERIMENTAL_FLAG` (or a single-flag variant) must not flip the
 * whole suite — scrub the env here; a test that wants a flag enables it
 * explicitly through the boot config.
 */

delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}
