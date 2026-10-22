# ILogService（logService）

- v2: `packages/agent-core-v2/src/_base/log/log.ts`（约 59 行，读 interface 得出）
- 新架构: `packages/agent-core/src/log/`（`log.ts` 契约 + `writer.ts` 自带写出端）

## 能力对照

- [x] 分级日志（error/warn/info/debug + setLevel 运行时调级）— `agent-core/src/log/log.ts` 的 `Logger`（每级一方法）+ `level`/`setLevel`；`createLogger` 内按 LEVEL_ORDER 次序过滤，等级为共享运行时状态，child 树同生效
- [x] 结构化日志条目与子上下文（LogEntry / ILogger.child）— `LogEntry`（t/level/message/context/error）+ `Logger.child(context)`，bound context 覆盖 per-call 同名字段，语义同 v2 `BoundLogger`
- [x] 可插拔写出端（ILogWriter.write）— 写出端即 `LogWriter.write(entry)` 单一接入点；core 自带 `consoleLogWriter` 与 `createMemoryLogWriter`。flush/close 不进 core：异步冲刷与关闭是 writer 内部队列的自持生命周期（参 v2 `RotatingFileWriter` + `drainLogCloses`），由宿主 writer 实现自行承载
- [x] 级别判定辅助（levelEnabled 的 LEVEL_ORDER 次序）— `agent-core/src/log/log.ts` 导出 `levelEnabled`，次序表与 v2 一致

## 结论

已对齐：日志 port 落在 `agent-core/src/log/`（平台无关，默认 `silentLogger` 静默），core 内 store（`openWriter`/`createReplica`）与 session（`CreateSessionOptions.logger`）的诊断通道已由 `onError = console.error` 默认值切换为注入 `Logger`；harness-core `createApp({ logger })` 透传，默认 `createLogger(consoleLogWriter)` 保持产品层可见行为。具体 writer 实现（轮转文件、格式化、脱敏）属宿主层职责，不在 core：需要时由宿主参照 v2 `fileLog.ts` / `formatter.ts` / `logConfig.ts` 自行实现，`LogWriter` 一个方法即可接入（含适配 pino 等既有库）。
