// src/cluster/topology.ts
//
// Cluster topology: the cluster.meta.json file that pins shardCount (and the
// codec/fsync defaults) for every process that opens the database. Creation
// races are resolved with O_EXCL: exactly one process writes the meta file,
// everyone else loads and validates against it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CLUSTER_META_FILE, shardDirName } from './utils.js';
import type { ClusterMeta, ClusterOpenOptions } from './types.js';

const META_VERSION = 1;
const DEFAULT_SHARD_COUNT = 16;

type TopologyOpts = Pick<ClusterOpenOptions, 'shardCount' | 'valueCodec' | 'fsyncPolicy'>;

export class Topology {
  private constructor(
    readonly dir: string,
    readonly meta: ClusterMeta,
  ) {}

  /** Create the cluster if dir has no meta file yet, otherwise load and
   *  validate the existing topology. Caller-specified values must match what
   *  is on disk; unspecified values inherit the disk topology. */
  static async open(dir: string, opts: TopologyOpts): Promise<Topology> {
    if (!dir) throw new TypeError('Topology.open: dir is required');
    if (opts.shardCount !== undefined && (!Number.isInteger(opts.shardCount) || opts.shardCount < 1)) {
      throw new RangeError(`shardCount must be a positive integer, got ${opts.shardCount}`);
    }
    await fs.mkdir(dir, { recursive: true });
    const metaPath = path.join(dir, CLUSTER_META_FILE);

    const requested: ClusterMeta = {
      version: META_VERSION,
      shardCount: opts.shardCount ?? DEFAULT_SHARD_COUNT,
      createdAt: new Date().toISOString(),
      valueCodec: opts.valueCodec ?? 'buffer',
      fsyncPolicy: opts.fsyncPolicy ?? 'everysec',
    };
    // Atomic creation race: write to a temp file, then hard-link it into
    // place. link(2) fails with EEXIST if another process won the race, and
    // unlike the O_EXCL-create-then-write pattern, readers can never observe
    // a meta file whose content has not been fully written yet.
    const tmpPath = `${metaPath}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(requested, null, 2));
      await fs.link(tmpPath, metaPath);
      return new Topology(dir, requested);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }

    const loaded = JSON.parse(await fs.readFile(metaPath, 'utf8')) as ClusterMeta;
    if (loaded.version !== META_VERSION) {
      throw new Error(`unsupported cluster meta version ${loaded.version} in ${metaPath}`);
    }
    if (!Number.isInteger(loaded.shardCount) || loaded.shardCount < 1) {
      throw new Error(`invalid shardCount in ${metaPath}`);
    }
    if (opts.shardCount !== undefined && opts.shardCount !== loaded.shardCount) {
      throw new RangeError(`cluster was created with shardCount=${loaded.shardCount}, got ${opts.shardCount}`);
    }
    if (opts.valueCodec !== undefined && opts.valueCodec !== loaded.valueCodec) {
      throw new RangeError(`cluster was created with valueCodec=${loaded.valueCodec}, got ${opts.valueCodec}`);
    }
    if (opts.fsyncPolicy !== undefined && opts.fsyncPolicy !== loaded.fsyncPolicy) {
      throw new RangeError(`cluster was created with fsyncPolicy=${loaded.fsyncPolicy}, got ${opts.fsyncPolicy}`);
    }
    return new Topology(dir, loaded);
  }

  get shardCount(): number {
    return this.meta.shardCount;
  }

  shardDir(shardId: number): string {
    return path.join(this.dir, shardDirName(shardId, this.meta.shardCount));
  }

  allShardDirs(): string[] {
    return Array.from({ length: this.meta.shardCount }, (_, i) => this.shardDir(i));
  }

  /** Create any missing shard directories. Runs on every open so a cluster
   *  interrupted between meta creation and directory creation heals on the
   *  next open. */
  async ensureShardDirs(): Promise<void> {
    await Promise.all(this.allShardDirs().map((d) => fs.mkdir(d, { recursive: true })));
  }
}
