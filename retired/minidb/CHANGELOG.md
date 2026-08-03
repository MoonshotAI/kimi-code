# @moonshot-ai/minidb

## 0.2.0

### Minor Changes

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Cluster readers of the embedded key-value engine now catch up incrementally by replaying only newly appended WAL frames after another process writes, instead of fully reopening the shard on every read; cross-process read latency drops by orders of magnitude at larger shard sizes, and readers still fall back to a full reopen after WAL rotation or truncation.

### Patch Changes

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Harden the embedded key-value engine's durability: WAL compaction now always terminates under sustained write storms instead of chasing the tail forever, a committed write can no longer slip through a compaction rotation undetected, torn WAL tails no longer misplace later disk-mode value pointers, read-only opens never create or modify database files or compact under a live writer, corrupt index-definition files no longer force a full rebuild, stale compaction temp files are cleaned on open, and the process lock can no longer be taken over by several processes at once.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Speed up the embedded key-value engine under stress: queries with skip/limit now stream candidates instead of decoding every match first, LRU eviction picks victims in O(1) instead of scanning every key, bursts of simultaneously expired TTL keys are drained within seconds, existence checks and size counting no longer read values when they only need metadata, and one oversized token can no longer poison the full-text index.

- [#1816](https://github.com/MoonshotAI/kimi-code/pull/1816) [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748) Thanks [@sailist](https://github.com/sailist)! - Keep the embedded key-value engine writable when a WAL compaction rotation fails mid-way instead of wedging it until reopen, stop a rolled-back write from erasing a concurrently committed value for the same key, let the RESP server survive aborted connections, recover after oversized requests, and answer each pipelined command independently, and keep the previous full-text index intact when a postings rebuild fails.
