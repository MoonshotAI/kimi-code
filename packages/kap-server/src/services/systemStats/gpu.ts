import type { SystemGpuStats } from '../../protocol/rest-system';

export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const NVIDIA_SMI_ARGS = ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'];
const NVIDIA_SMI_TIMEOUT_MS = 3_000;
const GPU_CACHE_MS = 5_000;
const FAILURE_RETRY_MS = 60_000;
const MISSING_RECHECK_MS = 10 * 60_000;
const MIB = 1024 * 1024;

function measurement(text: string | undefined, scale: number): number | undefined {
  const trimmed = text?.trim() ?? '';
  const value = Number(trimmed);
  return trimmed === '' || !Number.isFinite(value) ? undefined : value * scale;
}

export function parseNvidiaSmi(output: string): SystemGpuStats[] {
  const gpus: SystemGpuStats[] = [];
  for (const line of output.split('\n')) {
    const fields = line.split(',');
    if (fields.length < 5) continue;
    const index = Number(fields[0]!.trim());
    if (!Number.isInteger(index) || index < 0) continue;
    const [total, used, utilization] = fields.slice(-3);
    const share = measurement(utilization, 0.01);
    gpus.push({
      index,
      name: fields.slice(1, -3).join(',').trim(),
      memory_total: measurement(total, MIB),
      memory_used: measurement(used, MIB),
      utilization: share === undefined ? undefined : Math.min(1, share),
    });
  }
  return gpus;
}

function isMissingCommand(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

export class GpuReader {
  private cached: { readonly at: number; readonly gpus: SystemGpuStats[] } | undefined;
  private retryAt = 0;
  private pending: Promise<SystemGpuStats[]> | undefined;

  constructor(
    private readonly run: CommandRunner,
    private readonly now: () => number,
  ) {}

  read(): Promise<SystemGpuStats[]> {
    const now = this.now();
    if (this.cached !== undefined && now - this.cached.at < GPU_CACHE_MS) return Promise.resolve(this.cached.gpus);
    if (now < this.retryAt) return Promise.resolve([]);
    this.pending ??= this.query().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async query(): Promise<SystemGpuStats[]> {
    try {
      const gpus = parseNvidiaSmi(await this.run('nvidia-smi', NVIDIA_SMI_ARGS, NVIDIA_SMI_TIMEOUT_MS));
      this.cached = { at: this.now(), gpus };
      return gpus;
    } catch (error) {
      this.cached = undefined;
      this.retryAt = this.now() + (isMissingCommand(error) ? MISSING_RECHECK_MS : FAILURE_RETRY_MS);
      return [];
    }
  }
}
