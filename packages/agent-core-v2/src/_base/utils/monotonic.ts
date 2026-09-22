import { performance } from 'node:perf_hooks';

export function monoNowMs(): number {
  return performance.now();
}
