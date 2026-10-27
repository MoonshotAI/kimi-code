# ISessionRunGate（sessionRunGate）

- v2: `packages/agent-core-v2/src/session/sessionActivity/sessionRunGate.ts`（约 10 行；interface 仅 begin()，能力读实现 sessionRunGateService.ts 约 101 行得出）
- 新架构: 无对应

## 能力对照

- [ ] 会话锁持有/空闲释放（begin 时 hold，闲时 flush 后 release，供多客户端互斥）— 未迁：新栈两个包内无会话级锁服务；仅有 `packages/harness-core/src/host/session-space.ts` 的 journal `writer.lock`（单写入者文件锁，非同一能力）
- [ ] SESSION_STALE 检测（wire 被其他客户端外部修改时 begin 抛错，要求重新加载）— 未迁：新栈无 externallyModified 等价机制
- [ ] 闲时释放前 appendLog flush（释放锁前先把待写日志落盘）— 未迁：新栈 agent 自带 `flush()`（`packages/agent-core/src/session/session.ts`），但无与锁联动的闲时释放调度
- [ ] 会话关闭时强制释放锁（dispose 路径 release）与 3 秒闲时延迟常量 — 未迁：随锁服务一并缺失

## 结论

未对齐 4 项——多客户端会话锁、外部修改 stale 检测及配套释放调度均未迁移（多客户端并发语义在新栈尚未承载）。
