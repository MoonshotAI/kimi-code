# IWebFetchService（webFetchService）

- v2: `packages/agent-core-v2/src/app/web/web.ts`（约 15 行 interface）
- 新架构: `packages/harness-core/src/features/kimi/fetch/`

## 能力对照

- [x] getUrlFetcher（URL 抓取，passthrough/extracted 两种结果形态，支持 toolCallId/signal）→ `packages/harness-core/src/features/kimi/fetch/fetcher.ts` 的 UrlFetcher（同名契约）+ feature.ts 的 WebFetchRef
- [x] 多后端与 HttpFetchError → fetcher.ts 的 HttpFetchError + local.ts/moonshot.ts/proxy.ts 多后端实现

## 结论

全部对齐——URL 抓取能力由 kimi/fetch 承载。
