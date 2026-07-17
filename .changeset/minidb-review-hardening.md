---
"@moonshot-ai/minidb": patch
"@moonshot-ai/kimi-code": patch
---

Keep the embedded key-value engine writable when a WAL compaction rotation fails mid-way instead of wedging it until reopen, stop a rolled-back write from erasing a concurrently committed value for the same key, let the RESP server survive aborted connections, recover after oversized requests, and answer each pipelined command independently, and keep the previous full-text index intact when a postings rebuild fails.
