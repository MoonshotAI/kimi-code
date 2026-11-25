import { execFile } from 'node:child_process';
import type { StatsFs } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, homedir, totalmem, type CpuInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { SystemStats } from '../../protocol/rest-system';
import { readCgroupUsage, type CgroupUsage, type TextReader } from './cgroup';
import { GpuReader, type CommandRunner } from './gpu';

const CPU_WARMUP_MS = 250;
const CPU_BASELINE_STALE_MS = 60_000;
const CPU_MIN_INTERVAL_MS = 1_000;
const DISK_TIMEOUT_MS = 2_000;
const VM_STAT_TIMEOUT_MS = 2_000;

export interface SystemStatsSources {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly now: () => number;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly cpus: () => readonly CpuInfo[];
  readonly availableParallelism: () => number;
  readonly totalmem: () => number;
  readonly freemem: () => number;
  readonly readText: TextReader;
  readonly statfs: (path: string) => Promise<Pick<StatsFs, 'bsize' | 'blocks' | 'bfree' | 'bavail'>>;
  readonly run: CommandRunner;
}

const execFileAsync = promisify(execFile);

function nodeSources(): SystemStatsSources {
  return {
    platform: process.platform,
    homeDir: homedir(),
    now: Date.now,
    wait: async (ms, signal) => {
      await sleep(ms, undefined, { signal, ref: false });
    },
    cpus,
    availableParallelism,
    totalmem,
    freemem,
    readText: (path) => readFile(path, 'utf8').catch(() => undefined),
    statfs: (path) => statfs(path),
    run: async (file, args, timeoutMs) =>
      (await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout,
  };
}

interface CpuSample {
  readonly at: number;
  readonly idle: number;
  readonly total: number;
  readonly cgroupMicros?: number;
}

function ratio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function machineShare(previous: CpuSample, next: CpuSample): number | undefined {
  const total = next.total - previous.total;
  return total > 0 ? ratio(1 - (next.idle - previous.idle) / total) : undefined;
}

function cgroupShare(previous: CpuSample, next: CpuSample, cores: number): number | undefined {
  if (previous.cgroupMicros === undefined || next.cgroupMicros === undefined) return undefined;
  const wallMicros = (next.at - previous.at) * 1000;
  return wallMicros > 0 ? ratio((next.cgroupMicros - previous.cgroupMicros) / (wallMicros * cores)) : undefined;
}

export function parseVmStatUsed(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const pages = (label: string): number | undefined => {
    const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(output);
    return match === null ? undefined : Number(match[1]);
  };
  const anonymous = pages('Anonymous pages');
  const wired = pages('Pages wired down');
  if (!Number.isFinite(pageSize) || anonymous === undefined || wired === undefined) return undefined;
  const app = Math.max(0, anonymous - (pages('Pages purgeable') ?? 0));
  return (app + wired + (pages('Pages occupied by compressor') ?? 0)) * pageSize;
}

export class SystemStatsCollector {
  private baseline: CpuSample | undefined;
  private lastUsage: number | undefined;
  private readonly gpus: GpuReader;
  private readonly diskReads = new Map<string, Promise<SystemStats['disk']>>();

  constructor(private readonly sources: SystemStatsSources = nodeSources()) {
    this.gpus = new GpuReader(sources.run, sources.now);
  }

  async collect(path?: string): Promise<SystemStats> {
    const cgroup = await this.cgroup();
    const [cpu, memory, disk, gpus] = await Promise.all([
      this.cpu(cgroup),
      this.memory(cgroup),
      this.disk(path),
      this.sources.platform === 'darwin' ? [] : this.gpus.read(),
    ]);
    return { cpu, memory, disk, gpus };
  }

  private cgroup(): Promise<CgroupUsage> {
    return this.sources.platform === 'linux' ? readCgroupUsage(this.sources.readText) : Promise.resolve({});
  }

  private sampleCpu(cgroupMicros: number | undefined): CpuSample {
    let idle = 0;
    let total = 0;
    for (const { times } of this.sources.cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { at: this.sources.now(), idle, total, cgroupMicros };
  }

  private async cpu(cgroup: CgroupUsage): Promise<SystemStats['cpu']> {
    const machineCores = this.sources.cpus().length;
    const available = this.sources.availableParallelism();
    const cores = cgroup.cpuQuotaCores === undefined ? available : Math.min(cgroup.cpuQuotaCores, available);
    const limited = cores < machineCores;
    const fromCgroup = limited && cgroup.cpuUsageMicros !== undefined;
    let previous = this.baseline;
    let sample = this.sampleCpu(cgroup.cpuUsageMicros);
    if (previous === undefined || sample.at - previous.at > CPU_BASELINE_STALE_MS) {
      previous = sample;
      await this.sources.wait(CPU_WARMUP_MS);
      sample = this.sampleCpu(fromCgroup ? (await this.cgroup()).cpuUsageMicros : undefined);
    } else if (sample.at - previous.at < CPU_MIN_INTERVAL_MS) {
      return { usage: this.lastUsage, cores, limited };
    }
    this.baseline = sample;
    this.lastUsage = fromCgroup ? cgroupShare(previous, sample, cores) : machineShare(previous, sample);
    return { usage: this.lastUsage, cores, limited };
  }

  private async memory(cgroup: CgroupUsage): Promise<SystemStats['memory']> {
    const machineTotal = this.sources.totalmem();
    const limit = cgroup.memoryLimit;
    if (limit !== undefined && limit < machineTotal && cgroup.memoryUsed !== undefined) {
      return { total: limit, used: Math.min(cgroup.memoryUsed, limit), limited: true };
    }
    const reported = this.sources.platform === 'darwin' ? await this.darwinMemoryUsed() : undefined;
    const used = reported ?? machineTotal - this.sources.freemem();
    return { total: machineTotal, used: Math.min(Math.max(0, used), machineTotal), limited: false };
  }

  private async darwinMemoryUsed(): Promise<number | undefined> {
    try {
      return parseVmStatUsed(await this.sources.run('vm_stat', [], VM_STAT_TIMEOUT_MS));
    } catch {
      return undefined;
    }
  }

  private async disk(path: string | undefined): Promise<SystemStats['disk']> {
    const target = path !== undefined && isAbsolute(path) ? path : this.sources.homeDir;
    let pending = this.diskReads.get(target);
    if (pending === undefined) {
      pending = this.readDisk(target).finally(() => this.diskReads.delete(target));
      this.diskReads.set(target, pending);
    }
    const deadline = new AbortController();
    try {
      return await Promise.race([pending, this.sources.wait(DISK_TIMEOUT_MS, deadline.signal).then(() => undefined)]);
    } finally {
      deadline.abort();
    }
  }

  private async readDisk(path: string): Promise<SystemStats['disk']> {
    const candidates = path === this.sources.homeDir ? [path] : [path, this.sources.homeDir];
    for (const candidate of candidates) {
      try {
        const { bsize, blocks, bfree, bavail } = await this.sources.statfs(candidate);
        return { path: candidate, total: blocks * bsize, used: (blocks - bfree) * bsize, available: bavail * bsize };
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
