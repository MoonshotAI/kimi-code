/**
 * Anti-corruption invariant (Stage 1 hard rule, W4 STATUS quality gate).
 *
 * The daemon must not directly import the `@moonshot-ai/kimi-code-sdk` package
 * or use any of its concrete classes (KimiHarness / createRPC / SDKRpcClient).
 * The bridge layer in `@moonshot-ai/services` owns the in-process KimiCore +
 * RPC pair; daemon-side code crosses that boundary only via the broker
 * interfaces and `CoreProcessService.rpc`.
 *
 * This test is a guard rail — a single bad import here would re-couple the
 * daemon to the SDK shape we're explicitly migrating away from.
 */

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// packages/daemon/test → packages/daemon/src
const daemonSrc = resolve(here, '..', 'src');

describe('packages/daemon/src anti-corruption', () => {
  it('has zero @moonshot-ai/kimi-code-sdk / KimiHarness / createRPC / SDKRpcClient references', () => {
    // -r recursive; -E POSIX extended regex; `|| true` so a "no match" exit
    // code 1 doesn't fail the spawn. We assert on stdout being empty.
    const out = execSync(
      `grep -rE "@moonshot-ai/kimi-code-sdk|KimiHarness\\b|createRPC\\b|SDKRpcClient\\b" "${daemonSrc}" || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('');
  });
});
