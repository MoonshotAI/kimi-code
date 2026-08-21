import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRcDevices } from '../src/lib/rcDevicesApi';

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

  it('throws on a non-OK response', async () => {
    stubResponse({}, 500);
    await expect(fetchRcDevices()).rejects.toThrow('500');
  });
});
