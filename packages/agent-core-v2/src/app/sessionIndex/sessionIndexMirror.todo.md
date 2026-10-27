# ISessionIndexMirror（sessionIndexMirror）

- v2: `packages/agent-core-v2/src/app/sessionIndex/sessionIndex.ts`（约 72 行 interface；实现 sessionIndexMirrorService.ts，消费方为 sessionMetadata/sessionLifecycle/coldSessionArchive 等写方）
- 新架构: 无对应

## 能力对照

- [ ] record(summary)（写方同步登记摘要到镜像缓冲）— 未迁：新栈 sessionIndex 在事件监听内直接同步写 sqlite，无镜像缓冲层
- [ ] pending()/drain()（索引降级期间暂存、恢复后重灌）— 未迁：新栈无索引降级概念，伴随 sessionIndex 的写路径异常隔离缺口（见 sessionIndex.md）
- [ ] evict(id)（删除时从缓冲剔除）— 未迁：新栈删除走 session.deleted 事件直接删行

## 结论

未对齐——写后镜像机制整体未迁，新栈以同步直写 + 启动对账替代，降级缓冲语义缺失。
