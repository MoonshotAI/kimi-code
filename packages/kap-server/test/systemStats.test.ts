import { mkdtemp, rm } from 'node:fs/promises';
import type { CpuInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readCgroupUsage } from '../src/services/systemStats/cgroup';
import { parseNvidiaSmi } from '../src/services/systemStats/gpu';
import { parseVmStatUsed, SystemStatsCollector, type SystemStatsSources } from '../src/services/systemStats/systemStats';
import { startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function cpu(idle: number, busy: number): CpuInfo {
  return { model: 'example', speed: 0, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

function files(entries: Record<string, string>): (path: string) => Promise<string | undefined> {
  return async (path) => entries[path];
}

interface FakeMachine {
  readonly sources: SystemStatsSources;
  readonly setCpus: (next: CpuInfo[]) => void;
  readonly advance: (ms: number) => void;
  readonly run: ReturnType<typeof vi.fn<SystemStatsSources['run']>>;
  readonly statfs: ReturnType<typeof vi.fn<SystemStatsSources['statfs']>>;
}

function machine(overrides: Partial<SystemStatsSources> = {}, samples: CpuInfo[][] = []): FakeMachine {
  let clock = 1_000_000;
  let current = samples.shift() ?? [cpu(0, 0), cpu(0, 0)];
  const run = vi.fn<SystemStatsSources['run']>(async () => {
    throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
  });
  const statfs = vi.fn<SystemStatsSources['statfs']>(async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }));
  const sources: SystemStatsSources = {
    platform: 'linux',
    homeDir: '/home/example',
    now: () => clock,
    wait: async (ms) => {
      if (ms > 1_000) return new Promise<void>(() => {});
      clock += ms;
      current = samples.shift() ?? current;
    },
    cpus: () => current,
    availableParallelism: () => current.length,
    totalmem: () => 16 * GIB,
    freemem: () => 4 * GIB,
    readText: files({}),
    statfs,
    run,
    ...overrides,
  };
  return {
    sources,
    setCpus: (next) => {
      current = next;
    },
    advance: (ms) => {
      clock += ms;
    },
    run,
    statfs,
  };
}

describe('nvidia-smi output', () => {
  it('reads memory in bytes and utilization as a share, tolerating fields a GPU does not report', () => {
    expect(parseNvidiaSmi([
      '0, NVIDIA H100 80GB HBM3, 81559, 40780, 97',
      '1, NVIDIA A100-SXM4-80GB, 81920, 1, [N/A]',
      '2, Example, GPU, [Not Supported], [Not Supported], 0',
      '',
      'No devices were found',
    ].join('\n'))).toEqual([
      { index: 0, name: 'NVIDIA H100 80GB HBM3', memory_total: 81559 * MIB, memory_used: 40780 * MIB, utilization: 0.97 },
      { index: 1, name: 'NVIDIA A100-SXM4-80GB', memory_total: 81920 * MIB, memory_used: MIB, utilization: undefined },
      { index: 2, name: 'Example, GPU', memory_total: undefined, memory_used: undefined, utilization: 0 },
    ]);
  });
});

describe('macOS memory', () => {
  it('counts app, wired and compressed memory like Activity Monitor', () => {
    const output = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                5000.',
      'Pages active:                            200000.',
      'Pages inactive:                          190000.',
      'Pages purgeable:                          10000.',
      'Pages wired down:                        100000.',
      'Anonymous pages:                         300000.',
      'Pages occupied by compressor:             50000.',
    ].join('\n');
    expect(parseVmStatUsed(output)).toBe((300000 - 10000 + 100000 + 50000) * 16384);
    expect(parseVmStatUsed('Pages free: 1.')).toBeUndefined();
  });
});

describe('cgroup limits', () => {
  it('reads a cgroup v2 container quota and counts reclaimable file cache as free', async () => {
    await expect(readCgroupUsage(files({
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/cpu.max': '250000 100000\n',
      '/sys/fs/cgroup/cpu.stat': 'usage_usec 9000000\nuser_usec 1\n',
      '/sys/fs/cgroup/memory.max': `${String(8 * GIB)}\n`,
      '/sys/fs/cgroup/memory.current': `${String(6 * GIB)}\n`,
      '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${String(2 * GIB)}\n`,
    }))).resolves.toEqual({ cpuQuotaCores: 2.5, cpuUsageMicros: 9_000_000, memoryLimit: 8 * GIB, memoryUsed: 4 * GIB });
  });

  it('treats max as no limit in a nested cgroup v2 slice', async () => {
    await expect(readCgroupUsage(files({
      '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-1.scope\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/session-1.scope/cpu.max': 'max 100000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/session-1.scope/memory.max': 'max',
    }))).resolves.toEqual({ cpuQuotaCores: undefined, cpuUsageMicros: undefined, memoryLimit: undefined, memoryUsed: undefined });
  });

  it('reads cgroup v1 files at the container mount root when the host path is not mounted', async () => {
    await expect(readCgroupUsage(files({
      '/proc/self/cgroup': '12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n1:name=systemd:/docker/abc\n',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '400000',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000',
      '/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage': '5000000000',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(3 * GIB),
      '/sys/fs/cgroup/memory/memory.stat': `cache 1\ntotal_inactive_file ${String(GIB)}\n`,
    }))).resolves.toEqual({ cpuQuotaCores: 4, cpuUsageMicros: 5_000_000, memoryLimit: 9223372036854771712, memoryUsed: 2 * GIB });
  });

  it('reports nothing outside Linux cgroups', async () => {
    await expect(readCgroupUsage(files({}))).resolves.toEqual({});
  });
});

describe('system stats collector', () => {
  it('measures machine CPU from a short first sample, then from the previous request', async () => {
    const fake = machine({}, [
      [cpu(1000, 1000), cpu(1000, 1000)],
      [cpu(1050, 1150), cpu(1050, 1150)],
    ]);
    const collector = new SystemStatsCollector(fake.sources);

    await expect(collector.collect()).resolves.toEqual({
      cpu: { usage: 0.75, cores: 2, limited: false },
      memory: { total: 16 * GIB, used: 12 * GIB, limited: false },
      disk: { path: '/home/example', total: 1000 * 4096, used: 600 * 4096, available: 300 * 4096 },
      gpus: [],
    });

    fake.advance(500);
    fake.setCpus([cpu(2000, 1150), cpu(2000, 1150)]);
    expect((await collector.collect()).cpu.usage).toBe(0.75);

    fake.advance(4_500);
    expect((await collector.collect()).cpu.usage).toBe(0);
  });

  it('uses the container quota and its own CPU time when a limit applies', async () => {
    let usage = 1_000_000;
    const fake = machine({
      availableParallelism: () => 64,
      readText: async (path) => ({
        '/proc/self/cgroup': '0::/',
        '/sys/fs/cgroup/cpu.max': '200000 100000',
        '/sys/fs/cgroup/cpu.stat': `usage_usec ${String(usage)}`,
        '/sys/fs/cgroup/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/memory.current': String(2 * GIB),
        '/sys/fs/cgroup/memory.stat': 'inactive_file 0',
      } as Record<string, string>)[path],
      wait: async (ms) => {
        if (ms > 1_000) return new Promise<void>(() => {});
        fake.advance(ms);
        usage += 250_000;
      },
    }, [Array.from({ length: 64 }, () => cpu(0, 0))]);
    const collector = new SystemStatsCollector(fake.sources);

    const stats = await collector.collect();

    expect(stats.cpu).toEqual({ usage: 0.5, cores: 2, limited: true });
    expect(stats.memory).toEqual({ total: 8 * GIB, used: 2 * GIB, limited: true });
  });

  it('answers without the disk while a file system hangs and does not pile up more reads', async () => {
    const fake = machine({
      wait: async () => {},
    });
    fake.statfs.mockImplementation(() => new Promise(() => {}));
    const collector = new SystemStatsCollector(fake.sources);

    expect((await collector.collect('/mnt/stale')).disk).toBeUndefined();
    expect((await collector.collect('/mnt/stale')).disk).toBeUndefined();
    expect(fake.statfs).toHaveBeenCalledTimes(1);
  });

  it('falls back to the home directory when the project path is gone', async () => {
    const fake = machine();
    fake.statfs.mockImplementation(async (path) => {
      if (path === '/srv/removed') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { bsize: 512, blocks: 10, bfree: 5, bavail: 4 };
    });
    const collector = new SystemStatsCollector(fake.sources);

    expect((await collector.collect('/srv/removed')).disk).toEqual({ path: '/home/example', total: 5120, used: 2560, available: 2048 });
    expect((await collector.collect('relative/path')).disk?.path).toBe('/home/example');
  });

  it('reads macOS memory from vm_stat and never looks for NVIDIA GPUs there', async () => {
    const fake = machine({ platform: 'darwin' });
    fake.run.mockResolvedValue('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages wired down: 1000.\nAnonymous pages: 3000.\n');
    const collector = new SystemStatsCollector(fake.sources);

    const stats = await collector.collect();

    expect(stats.memory).toEqual({ total: 16 * GIB, used: 4000 * 4096, limited: false });
    expect(stats.gpus).toEqual([]);
    expect(fake.run.mock.calls.map(([file]) => file)).toEqual(['vm_stat']);
  });

  it('lists GPUs from nvidia-smi, reuses a fresh answer and stops asking for a while when it is missing', async () => {
    const fake = machine();
    fake.run.mockResolvedValueOnce('0, NVIDIA L4, 23034, 11517, 50\n');
    const collector = new SystemStatsCollector(fake.sources);

    expect((await collector.collect()).gpus).toEqual([
      { index: 0, name: 'NVIDIA L4', memory_total: 23034 * MIB, memory_used: 11517 * MIB, utilization: 0.5 },
    ]);
    fake.advance(1_000);
    await collector.collect();
    expect(fake.run).toHaveBeenCalledTimes(1);

    fake.advance(5_000);
    expect((await collector.collect()).gpus).toEqual([]);
    fake.advance(60_000);
    await collector.collect();
    expect(fake.run).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/v1/system/stats', () => {
  it('reports the usage of this computer and advertises the capability', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-system-stats-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, { headers: authHeaders(server) });
      return (await response.json()) as { code: number; data: Record<string, unknown> };
    };
    try {
      const meta = await get('/api/v1/meta');
      expect(meta.data['capabilities']).toMatchObject({ system_stats: true });
      const stats = await get(`/api/v1/system/stats?path=${encodeURIComponent(home)}`);
      expect(stats.code).toBe(0);
      expect(stats.data).toMatchObject({
        cpu: { cores: expect.any(Number), limited: expect.any(Boolean) },
        memory: { total: expect.any(Number), used: expect.any(Number) },
        disk: { path: home, total: expect.any(Number) },
        gpus: expect.any(Array),
      });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
