import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRcDevices, RcDevicesFetchError, renameRcDevice, deactivateRcDevice } from '../src/lib/rcDevicesApi';

describe('fetchRcDevices', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(body: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it('returns the rows and the device cap', async () => {
    stubResponse({ devices: [{ device_id: 'a' }, { device_id: 'b' }], max_devices: 5 });
    const list = await fetchRcDevices();
    expect(list.devices).toHaveLength(2);
    expect(list.max_devices).toBe(5);
  });

  it('tolerates a missing cap and missing rows', async () => {
    stubResponse({});
    const list = await fetchRcDevices();
    expect(list.devices).toEqual([]);
    expect(list.max_devices).toBeUndefined();
  });

  it('ignores a non-numeric cap', async () => {
    stubResponse({ devices: [], max_devices: '5' });
    expect((await fetchRcDevices()).max_devices).toBeUndefined();
  });

  it('throws a typed error with the status on a non-OK response', async () => {
    stubResponse({}, 500);
    await expect(fetchRcDevices()).rejects.toThrow('500');
    stubResponse({}, 401);
    const error = await fetchRcDevices().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RcDevicesFetchError);
    expect((error as RcDevicesFetchError).status).toBe(401);
  });
});

describe('rc device mutations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status = 200): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('renames via PATCH with the alias body', async () => {
    const spy = stubFetch();
    await renameRcDevice('dev 1', '公司 MacBook');
    expect(spy).toHaveBeenCalledWith('/v1/remote/devices/dev%201', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: '公司 MacBook' }),
    });
  });

  it('deactivates via POST to the deactivate endpoint', async () => {
    const spy = stubFetch();
    await deactivateRcDevice('dev-1');
    expect(spy).toHaveBeenCalledWith('/v1/remote/devices/dev-1/deactivate', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });
});
