# IWSGateway（wsGateway）

- v2: `packages/agent-core-v2/src/app/gateway/gateway.ts`（约 33 行 interface；实现 gatewayService.ts 中 WSGateway.broadcast 为空 stub，真实 WS 广播由 kap-server transport 承担，故以 kap WS 线协议为能力基准）
- 新架构: `packages/harness-core/src/feature-http/ws.ts` + `packages/harness-core/src/feature-http/ws-v1/`

## 能力对照

- [x] connect（WS 连接接入、注册与心跳）→ `packages/harness-core/src/feature-http/ws.ts` 的 useWsEndpoint（connections 注册 + 30s ping）与 `packages/harness-core/src/feature-http/ws-registry.ts`
- [x] broadcast（会话事件向订阅方广播）→ ws.ts 的 WS_EVENT_TYPES 会话事件广播与 agent turn/delta 双档订阅，及 `packages/harness-core/src/feature-http/ws-v1/connection.ts` 的全量会话事件流
- [x] 事件投影协议（seq/epoch 游标、断线 replay、resyncRequired 重同步）→ `packages/harness-core/src/feature-http/ws-v1/journal.ts` 的 SessionEventJournal（epoch_changed/buffer_overflow）与 transcript journal（op 批次 backfill）

## 结论

全部对齐——v2 该接口本身为空 stub，能力以 kap WS 线协议为准，新栈 ws（原生订阅）与 ws-v1（seq/epoch 投影）两端点完整承载。
