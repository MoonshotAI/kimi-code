import { describe, expect, it } from 'vitest';

import {
  capabilityStatusSchema,
  listCapabilitiesResponseSchema,
} from '../src/protocol/rest-capability';
import { sharedAuthHeaders, sharedServer } from './helpers/sharedServer';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1 capabilities', () => {
  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${sharedServer().base}${path}`, {
      headers: sharedAuthHeaders(),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${sharedServer().base}${path}`, {
      method: 'POST',
      headers: sharedAuthHeaders(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists both built-in capabilities with the documented shape', async () => {
    const { body } = await getJson<unknown>('/api/v1/capabilities');
    expect(body.code).toBe(0);
    const parsed = listCapabilitiesResponseSchema.parse(body.data);
    const ids = parsed.capabilities.map((c) => c.id).toSorted();
    expect(ids).toEqual(['kimi-cu', 'kimi-webbridge']);
    for (const capability of parsed.capabilities) {
      expect(capabilityStatusSchema.parse(capability)).toBeTruthy();
      expect(capability.install.running).toBe(false);
    }
    const kimiCu = parsed.capabilities.find((c) => c.id === 'kimi-cu');
    if (process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64')) {
      expect(kimiCu?.supported).toBe(true);
    } else {
      expect(kimiCu?.supported).toBe(false);
      expect(kimiCu?.state).toBe('unsupported');
    }
    const webbridge = parsed.capabilities.find((c) => c.id === 'kimi-webbridge');
    expect(webbridge?.supported).toBe(true);
    expect(webbridge?.steps.find((s) => s.id === 'skill')?.state).toBe('missing');
    expect(webbridge?.steps.find((s) => s.id === 'extension')?.optional).toBe(true);
  });

  it('gets a single capability and 40418s on an unknown id', async () => {
    const { body } = await getJson<unknown>('/api/v1/capabilities/kimi-webbridge');
    expect(body.code).toBe(0);
    expect(capabilityStatusSchema.parse(body.data).id).toBe('kimi-webbridge');

    const missing = await getJson<unknown>('/api/v1/capabilities/nope');
    expect(missing.body.code).toBe(40418);
    expect(missing.body.data).toBeNull();
  });

  it.each([undefined, {}])('accepts install requests with body %j without side effects', async (input) => {
    const { body } = await postJson<unknown>('/api/v1/capabilities/nope:install', input);
    expect(body.code).toBe(40418);
  });

  it('validates process termination consent as a boolean', async () => {
    const invalid = await postJson<unknown>('/api/v1/capabilities/nope:install', { stopRunningProcesses: 'true' });
    expect(invalid.body.code).toBe(40001);
    const valid = await postJson<unknown>('/api/v1/capabilities/nope:install', { stopRunningProcesses: true });
    expect(valid.body.code).toBe(40418);
  });

  it('rejects bare ids and unknown actions with 40001', async () => {
    const bare = await postJson<unknown>('/api/v1/capabilities/kimi-cu');
    expect(bare.body.code).toBe(40001);
    const bogus = await postJson<unknown>('/api/v1/capabilities/kimi-cu:uninstall');
    expect(bogus.body.code).toBe(40001);
  });

  it.skipIf(process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64'))(
    'rejects kimi-cu install on unsupported platforms with 40925',
    async () => {
      const { body } = await postJson<unknown>('/api/v1/capabilities/kimi-cu:install');
      expect(body.code).toBe(40925);
    },
  );
});
