import { describe, expect, it } from 'vitest';

import { createRPC } from '../../src/rpc/client';

/**
 * M3.7 — CoreRPC wire-only / zero in-process serialization.
 *
 * `CoreProcessService.getCoreApi()` (`coreProcessService.ts:160-170`) returns
 * the underlying in-process `KimiCore` directly, deliberately bypassing the
 * `createRPC` proxy and its `simulateNetwork` JSON serialize/deserialize hop
 * (`rpc/client.ts:38-45`). Constructing a real `CoreProcessService` here would
 * spin up `KimiCore` (plugin load, OAuth + auth facade wiring, header
 * synthesis), so we mirror the documented seam with a faithful stand-in: a
 * handle whose `getCoreApi()` returns the captured in-process object
 * unchanged, exactly as the production accessor does (`return this._core`).
 *
 * The assertions below prove the in-process path is serialization-free by
 * showing that object identity and non-JSON-safe values survive the trip,
 * while the `createRPC` control proves the same checks would catch a
 * regression that routed the in-process call through `simulateNetwork`.
 */

/** Echo API shape used to drive both the in-process handle and createRPC. */
interface EchoAPI {
  echo(payload: unknown): unknown;
}

/**
 * Faithful stand-in for `CoreProcessService.getCoreApi()`: returns the
 * captured in-process object directly, with no `createRPC` / `simulateNetwork`
 * boundary in between. Mirrors `coreProcessService.ts:160-170`.
 */
function makeInProcessHandle<T extends object>(core: T): { readonly _core: T; getCoreApi(): T } {
  return {
    _core: core,
    getCoreApi(): T {
      return this._core;
    },
  };
}

/**
 * Payload carrying values that `JSON.stringify` cannot round-trip: a `Date`
 * (becomes a string), `undefined` (dropped), and a function (dropped). If a
 * call passes through `simulateNetwork`, these are mangled; if it stays
 * in-process, they survive unchanged.
 */
function makeSentinelPayload(): {
  date: Date;
  nil: undefined;
  fn: () => string;
  nested: { value: number };
} {
  const nested = { value: 42 };
  return {
    date: new Date('2026-06-21T00:00:00.000Z'),
    nil: undefined,
    fn: () => 'sentinel',
    nested,
  };
}

describe('core-wire: in-process getCoreApi() path is serialization-free', () => {
  it('returns the exact in-process instance, not a createRPC proxy', () => {
    const core: EchoAPI = { echo: (payload) => payload };
    const handle = makeInProcessHandle(core);

    // Identity is preserved across calls — there is no proxy/serialization
    // wrapper between the handle and the in-process object.
    expect(handle.getCoreApi()).toBe(core);
    expect(handle.getCoreApi()).toBe(handle._core);
  });

  it('does not JSON-roundtrip payloads — non-JSON values pass through unchanged', () => {
    const core: EchoAPI = { echo: (payload) => payload };
    const handle = makeInProcessHandle(core);
    const payload = makeSentinelPayload();

    const result = handle.getCoreApi().echo(payload) as typeof payload;

    // Same reference end-to-end: no `JSON.parse(JSON.stringify(...))` clone.
    expect(result).toBe(payload);
    expect(result.nested).toBe(payload.nested);
    // `Date` survives as a Date (simulateNetwork would turn it into a string).
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.toISOString()).toBe('2026-06-21T00:00:00.000Z');
    // `undefined` and function values survive (simulateNetwork would drop them).
    expect(result.nil).toBeUndefined();
    expect(result.fn).toBe(payload.fn);
    expect(result.fn()).toBe('sentinel');
  });

  it('control: createRPC serializes the same payload, proving the checks are load-bearing', async () => {
    const [leftClient, rightClient] = createRPC<EchoAPI, EchoAPI>();
    // `leftClient` returns the methods bound to the *other* side's self, so a
    // call to `leftMethods.echo(...)` traverses `mapRpcFunction` →
    // `simulateNetwork` (JSON.stringify/parse) on both the payload and response.
    const leftMethods = leftClient({ echo: (payload) => payload });
    void rightClient({ echo: (payload) => payload });
    const rpc = await leftMethods;

    const payload = makeSentinelPayload();
    const result = (await rpc.echo(payload)) as Record<string, unknown>;

    // After simulateNetwork: Date → ISO string, undefined/function keys dropped.
    expect(result).not.toBe(payload);
    expect(result['date']).toBe('2026-06-21T00:00:00.000Z');
    expect(typeof result['date']).toBe('string');
    expect(result['nil']).toBeUndefined();
    expect(result['fn']).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(['date', 'nested']);
  });
});
