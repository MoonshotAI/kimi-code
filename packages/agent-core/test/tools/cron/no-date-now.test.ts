/**
 * Guard: forbid `Date.now()` in cron scheduler-adjacent files.
 *
 * The cron scheduler routes every wall-clock read through
 * `ClockSources.wallNow()` so that tests and benches can inject a
 * simulated clock (see `tools/cron/clock.ts`). A stray `Date.now()`
 * call inside `scheduler.ts` / `persist.ts` / `lock.ts` / `jitter.ts`
 * silently bypasses that injection — the bug is invisible until the
 * bench notices its frozen clock did not freeze a heartbeat.
 *
 * The natural place for this guard is an ESLint rule
 * (`no-restricted-syntax` matching `CallExpression[callee.object.name=
 * "Date"][callee.property.name="now"]`), but this repo lints with
 * **oxlint**, and oxlint 1.59 does not implement `no-restricted-syntax`
 * — only `no-restricted-globals`, `no-restricted-imports`,
 * `no-restricted-exports`, and `no-restricted-types`. Loading the rule
 * makes oxlint refuse to parse the config:
 *
 *     Failed to parse oxlint configuration file.
 *       x Rule 'no-restricted-syntax' not found in plugin 'eslint'
 *
 * As a fallback, we scan the source files here from a vitest test that
 * runs in the regular `pnpm test` flow.
 *
 * Important: `clock.ts` is deliberately **excluded** — it is the one
 * file where `Date.now()` is the *implementation* of the wall-clock
 * abstraction (see `SYSTEM_CLOCKS` and the parse-failure fallbacks in
 * `readEnvWall` / `readFileWall`). Banning `Date.now()` there would be
 * banning the abstraction's only legal definition.
 *
 * Files that don't exist yet (`scheduler.ts`, `persist.ts`, `lock.ts`)
 * are skipped — the guard activates automatically when later commits
 * introduce them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'pathe';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `test/tools/cron/` → package root → `src/tools/cron/`.
const cronSrcDir = join(here, '..', '..', '..', 'src', 'tools', 'cron');

const GUARDED_FILES = [
  'scheduler.ts',
  'persist.ts',
  'lock.ts',
  'jitter.ts',
] as const;

// Matches a `Date.now(` call. Word boundary on the `D` side so it
// won't trip on `myDate.now(` or `notDate.now(`; arbitrary whitespace
// between `now` and `(` so `Date.now ()` and `Date . now (` both
// catch.  The intent is "the CallExpression `Date.now(...)`" — this
// regex is the cheap proxy for the AST selector we'd use in ESLint.
const DATE_NOW_REGEX = /\bDate\s*\.\s*now\s*\(/;

describe('cron scheduler files do not call Date.now()', () => {
  for (const file of GUARDED_FILES) {
    it(`${file} contains no Date.now() call`, () => {
      const path = join(cronSrcDir, file);
      if (!existsSync(path)) {
        // File hasn't been added yet (P1/P2 commits introduce
        // scheduler.ts, persist.ts, lock.ts). The guard activates
        // automatically once they exist.
        return;
      }
      const source = readFileSync(path, 'utf8');
      const match = DATE_NOW_REGEX.exec(source);
      expect(
        match,
        `Found \`Date.now()\` in ${file} at offset ${match?.index ?? -1}. ` +
          `Use ClockSources.wallNow() instead — direct Date.now() bypasses ` +
          `test/bench clock injection. clock.ts is the single legal exception.`,
      ).toBeNull();
    });
  }
});
