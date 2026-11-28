import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  probeLocalNetworkPermission,
  randomLinkLocalIpv6,
  triggerLocalNetworkPrompt,
} from '../../../src/main/system/local-network';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/nonexistent-app' },
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('randomLinkLocalIpv6', () => {
  it('generates randomized addresses inside fe80::/10', () => {
    const addresses = new Set<string>();
    for (let index = 0; index < 64; index++) {
      const address = randomLinkLocalIpv6();
      const firstGroup = Number.parseInt(address.split(':')[0]!, 16);
      expect(firstGroup).toBeGreaterThanOrEqual(0xfe80);
      expect(firstGroup).toBeLessThanOrEqual(0xfebf);
      addresses.add(address);
    }
    expect(addresses.size).toBeGreaterThan(1);
  });

  it('formats deterministic bytes without IPv4-mapped or gateway literals', () => {
    const bytes = Buffer.from([0x00, 0x00, 0x12, 0x34, 0xab, 0xcd, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09]);
    expect(randomLinkLocalIpv6(bytes)).toBe('fe80:1234:abcd:1:0:0:0:9');
  });
});

describe('triggerLocalNetworkPrompt', () => {
  it('connects a UDP socket to port 9 without sending datagrams and closes it', async () => {
    vi.useFakeTimers();
    const socket = new EventEmitter() as EventEmitter & {
      connect: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    socket.send = vi.fn();
    socket.close = vi.fn();
    socket.connect = vi.fn((_port: number, _address: string, callback: () => void) => callback());
    const pending = triggerLocalNetworkPrompt(() => socket as never, 50);
    expect(socket.connect).toHaveBeenCalledOnce();
    const [port, address] = socket.connect.mock.calls[0]!;
    expect(port).toBe(9);
    expect(String(address)).toMatch(/^fe[89ab][0-9a-f]:/);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('closes the socket and resolves when connect emits an error', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      connect: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    socket.close = vi.fn();
    socket.connect = vi.fn(() => socket.emit('error', new Error('ENETUNREACH')));
    await triggerLocalNetworkPrompt(() => socket as never);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('resolves when socket creation throws', async () => {
    await expect(triggerLocalNetworkPrompt(() => { throw new Error('unsupported'); })).resolves.toBeUndefined();
  });
});

describe('probeLocalNetworkPermission', () => {
  it('degrades to unavailable when the native module is absent', async () => {
    await expect(probeLocalNetworkPermission()).resolves.toBe('unavailable');
  });
});
