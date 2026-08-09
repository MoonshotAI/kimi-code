// src/cluster/router.ts
//
// Key -> shard routing. Pure functions of (key, shardCount) so every process
// agrees on placement without any coordination.

import path from 'node:path';
import type { ClusterMeta } from './types.js';
import { shardDirName, shardFor } from './utils.js';

export class Router {
  constructor(
    private readonly baseDir: string,
    private readonly meta: ClusterMeta,
  ) {}

  get shardCount(): number {
    return this.meta.shardCount;
  }

  shardFor(key: string): number {
    return shardFor(key, this.meta.shardCount);
  }

  shardDir(shardId: number): string {
    return path.join(this.baseDir, shardDirName(shardId, this.meta.shardCount));
  }

  shardIds(): number[] {
    return Array.from({ length: this.meta.shardCount }, (_, i) => i);
  }
}
