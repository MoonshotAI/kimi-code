import { join } from 'node:path';

export type TextReader = (path: string) => Promise<string | undefined>;

export interface CgroupUsage {
  readonly cpuQuotaCores?: number;
  readonly cpuUsageMicros?: number;
  readonly memoryLimit?: number;
  readonly memoryUsed?: number;
}

const CGROUP_ROOT = '/sys/fs/cgroup';

interface LegacyController {
  readonly mount: string;
  readonly path: string;
}

interface CgroupMembership {
  readonly unified?: string;
  readonly legacy: ReadonlyMap<string, LegacyController>;
}

function parseMembership(text: string): CgroupMembership {
  let unified: string | undefined;
  const legacy = new Map<string, LegacyController>();
  for (const line of text.split('\n')) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line.trim());
    if (match === null) continue;
    const names = match[1]!;
    const path = match[2]!;
    if (names === '') {
      unified = path;
      continue;
    }
    for (const name of names.split(',')) legacy.set(name, { mount: join(CGROUP_ROOT, names), path });
  }
  return { unified, legacy };
}

function numberIn(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

function statField(text: string | undefined, field: string): number | undefined {
  const line = text?.split('\n').find((entry) => entry.startsWith(`${field} `));
  return numberIn(line?.slice(field.length + 1));
}

function memoryInUse(current: number | undefined, stat: string | undefined, inactiveFileField: string): number | undefined {
  if (current === undefined) return undefined;
  return Math.max(0, current - (statField(stat, inactiveFileField) ?? 0));
}

async function readUnified(read: TextReader, path: string): Promise<CgroupUsage> {
  const dir = path === '/' ? CGROUP_ROOT : join(CGROUP_ROOT, path);
  const [cpuMax, cpuStat, memoryMax, memoryCurrent, memoryStat] = await Promise.all([
    read(join(dir, 'cpu.max')),
    read(join(dir, 'cpu.stat')),
    read(join(dir, 'memory.max')),
    read(join(dir, 'memory.current')),
    read(join(dir, 'memory.stat')),
  ]);
  const [quota, period] = cpuMax?.trim().split(/\s+/) ?? [];
  const quotaMicros = quota === 'max' ? undefined : numberIn(quota);
  const periodMicros = numberIn(period);
  return {
    cpuQuotaCores: quotaMicros !== undefined && periodMicros ? quotaMicros / periodMicros : undefined,
    cpuUsageMicros: statField(cpuStat, 'usage_usec'),
    memoryLimit: memoryMax?.trim() === 'max' ? undefined : numberIn(memoryMax),
    memoryUsed: memoryInUse(numberIn(memoryCurrent), memoryStat, 'inactive_file'),
  };
}

async function readLegacyFile(read: TextReader, membership: CgroupMembership, controller: string, file: string): Promise<string | undefined> {
  const location = membership.legacy.get(controller);
  if (location === undefined) return undefined;
  const nested = await read(join(location.mount, location.path, file));
  if (nested !== undefined || location.path === '/') return nested;
  return read(join(location.mount, file));
}

async function readLegacy(read: TextReader, membership: CgroupMembership): Promise<CgroupUsage> {
  const [quota, period, usageNanos, limit, usage, stat] = await Promise.all([
    readLegacyFile(read, membership, 'cpu', 'cpu.cfs_quota_us'),
    readLegacyFile(read, membership, 'cpu', 'cpu.cfs_period_us'),
    readLegacyFile(read, membership, 'cpuacct', 'cpuacct.usage'),
    readLegacyFile(read, membership, 'memory', 'memory.limit_in_bytes'),
    readLegacyFile(read, membership, 'memory', 'memory.usage_in_bytes'),
    readLegacyFile(read, membership, 'memory', 'memory.stat'),
  ]);
  const quotaMicros = numberIn(quota);
  const periodMicros = numberIn(period);
  const nanos = numberIn(usageNanos);
  return {
    cpuQuotaCores: quotaMicros !== undefined && quotaMicros > 0 && periodMicros ? quotaMicros / periodMicros : undefined,
    cpuUsageMicros: nanos === undefined ? undefined : nanos / 1000,
    memoryLimit: numberIn(limit),
    memoryUsed: memoryInUse(numberIn(usage), stat, 'total_inactive_file'),
  };
}

export async function readCgroupUsage(read: TextReader): Promise<CgroupUsage> {
  const text = await read('/proc/self/cgroup');
  if (text === undefined) return {};
  const membership = parseMembership(text);
  if (membership.legacy.has('cpu') || membership.legacy.has('memory')) return readLegacy(read, membership);
  return membership.unified === undefined ? {} : readUnified(read, membership.unified);
}
